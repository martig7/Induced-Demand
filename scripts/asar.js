// Minimal, dependency-free asar reader.
// Usage:
//   node asar.js list <asar>                 -> print "size\tpath" for every file
//   node asar.js cat  <asar> <internalPath>  -> write file bytes to stdout
//   node asar.js extract <asar> <glob> <outDir> -> extract files whose path includes <glob substring>
const fs = require('fs');
const path = require('path');

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // head: [0..3]=4, [4..7]=headerPickleSize, [8..11]=jsonPickleSize, [12..15]=jsonStrSize
  const headerPickleSize = head.readUInt32LE(4);
  const jsonStrSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonStrSize);
  fs.readSync(fd, jsonBuf, 0, jsonStrSize, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  // Data section starts after the 8-byte size pickle prefix + headerPickleSize
  const baseOffset = 8 + headerPickleSize;
  return { fd, header, baseOffset };
}

function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix ? prefix + '/' + name : name, out);
    }
  } else {
    out.push({ path: prefix, size: node.size || 0, offset: node.offset, unpacked: !!node.unpacked });
  }
}

function getFiles(header) {
  const out = [];
  walk(header, '', out);
  return out;
}

function findEntry(header, target) {
  const files = getFiles(header);
  return files.find((f) => f.path === target.replace(/\\/g, '/'));
}

function readFileBytes(asarPath, target) {
  const { fd, header, baseOffset } = readHeader(asarPath);
  const e = findEntry(header, target);
  if (!e) throw new Error('not found: ' + target);
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset));
  fs.closeSync(fd);
  return buf;
}

const [, , cmd, asarPath, a3, a4] = process.argv;
if (cmd === 'list') {
  const { header } = readHeader(asarPath);
  const files = getFiles(header).sort((x, y) => x.path.localeCompare(y.path));
  for (const f of files) console.log(`${f.size}\t${f.unpacked ? 'U ' : '  '}${f.path}`);
  console.error(`TOTAL ${files.length} files`);
} else if (cmd === 'cat') {
  process.stdout.write(readFileBytes(asarPath, a3));
} else if (cmd === 'extract') {
  // a3 = substring filter, a4 = outDir
  const { fd, header, baseOffset } = readHeader(asarPath);
  const files = getFiles(header).filter((f) => f.path.includes(a3) && !f.unpacked);
  for (const f of files) {
    const dest = path.join(a4, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset));
    fs.writeFileSync(dest, buf);
  }
  console.error(`extracted ${files.length} files matching "${a3}" to ${a4}`);
} else {
  console.error('usage: list|cat|extract');
}
