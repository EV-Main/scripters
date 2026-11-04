const test = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('./merge.js');

test('edits of different lines both land', () => {
	assert.equal(merge('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'), 'A\nb\nC\n');
	assert.equal(merge('# A\n', '# A\n\n# B\nHi\n', '# A\nedited\n'), '# A\nedited\n\n# B\nHi\n');
});

test('a card appended past the last line edited elsewhere lands', () => {
	assert.equal(merge('# A\nx\n', '# A\nx\n\n# B\n', '# A\ny\n'), '# A\ny\n\n# B\n');
});

test('edits of one line clash', () => {
	assert.equal(merge('a\nb\n', 'a\nB\n', 'a\nβ\n'), null);
	assert.equal(merge('a\n', 'a\nb\n', 'a\nc\n'), null);
});

test('one side unchanged takes the other', () => {
	assert.equal(merge('a\nb', 'a\nb', 'x\ny\nz'), 'x\ny\nz');
	assert.equal(merge('a\nb', 'b', 'a\nb'), 'b');
});
