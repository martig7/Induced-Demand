// node ctx.js <file> <regex> [window] [maxHits]
const fs = require('fs');
const [, , file, pat, win = '400', maxHits = '40'] = process.argv;
const s = fs.readFileSync(file, 'utf8');
const re = new RegExp(pat, 'g');
const w = parseInt(win, 10);
let m, n = 0;
const seen = new Set();
while ((m = re.exec(s)) && n < parseInt(maxHits, 10)) {
  const start = Math.max(0, m.index - w);
  const end = Math.min(s.length, m.index + m[0].length + w);
  const key = Math.floor(m.index / 50);
  console.log(`\n===== @${m.index} (match: ${JSON.stringify(m[0])}) =====`);
  console.log(s.slice(start, end));
  n++;
  if (m.index === re.lastIndex) re.lastIndex++;
}
console.error(`hits printed: ${n}`);
