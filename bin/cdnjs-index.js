#!/usr/bin/env node
global._ = require('lodash'); // ¯\_(ツ)_/¯
const zlib = require('zlib');
const tar = require('tar-stream');
const config = require('config');
const got = require('got');

const db = require('../src/lib/db/index.js');
const CndJsPackage = require('../src/models/CdnJsPackage.js');

const httpClient = got.extend({ headers: { 'user-agent': config.get('server.userAgent') } });

const tarballUrl = 'https://github.com/cdnjs/packages/tarball/master';
const versionedListUrl = 'https://api.cdnjs.com/libraries/?fields=version';

const batchSize = 100;
const batchEntries = [];

const insertBatch = async (batch) => {
	await db(CndJsPackage.table).insert(batch).onConflict().ignore();
};

const fetchVersionsList = async () => {
	let response = await httpClient(versionedListUrl, { json: true });
	return new Map(response.body.results.map(p => [ p.name, p.version ]));
};

const fetchPackages = (versionsMap) => {
	let extract = tar.extract();
	let total = 0;

	extract.on('entry', async (header, stream, next) => {
		if (header.type !== 'file') {
			return next();
		}

		let name = header.name.replace(/\\/g, '/').replace(/^[^/]+\//, '');

		if (!name.startsWith('packages/') || !name.endsWith('.json')) {
			return next();
		}

		let chunks = [];

		for await (let chunk of stream) {
			chunks.push(chunk);
		}

		let payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
		let packageVersion = versionsMap.get(payload.name);

		// skip non-npm or packages without default file
		// https://github.com/cdnjs/packages/blob/master/packages/a/ant-design-icons-svg.json
		if (!packageVersion || !payload.autoupdate || payload.autoupdate.source !== 'npm' || !payload.filename) {
			return next();
		}

		batchEntries.push({
			name: payload.autoupdate.target,
			version: packageVersion,
			filename: payload.filename,
		});

		if (batchEntries.length > batchSize) {
			let batch = batchEntries.splice(0, batchSize);
			await insertBatch(batch);

			total += batch.length;
			console.log(`${total} packages processed`);
		}

		next();
	});

	extract.on('finish', async () => {
		total += batchEntries.length;
		await insertBatch(batchEntries);
		console.log(`Total packages processed: ${total}`);

		db.destroy(() => console.log('DB connection closed'));
	});

	return extract;
};

fetchVersionsList()
	.then((versionsList) => {
		httpClient.stream(tarballUrl)
			.pipe(zlib.createGunzip())
			// eslint-disable-next-line
			.pipe(fetchPackages(versionsList));
	})
	.catch(err => console.error(err));
