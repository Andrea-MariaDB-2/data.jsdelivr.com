exports.up = async (db) => {
	await db.schema.createTable('cdnjs_package', (table) => {
		table.string('name');
		table.string('version');
		table.string('filename');
		table.unique([ 'name', 'version' ]);
	});
};

exports.down = () => {};
