// 临时诊断脚本：找出 ES 模块顶层括号不匹配的位置
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const src = readFileSync(file, 'utf8');
let depth = 0, paren = 0, bracket = 0;
let inC = null, inBlock = false, inTpl = false, inRegex = false;
const stack = [];
const lines = src.split('\n');
for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  for (let j = 0; j < line.length; j++) {
    const c = line[j], n = line[j + 1], p = line[j - 1];
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
    if (inC) { if (c === '\\') { j++; continue; } if (c === inC) inC = null; continue; }
    if (inTpl) { if (c === '\\') { j++; continue; } if (c === '`') inTpl = false; continue; }
    if (inRegex) { if (c === '\\') { j++; continue; } if (c === '/') inRegex = false; continue; }
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') { inBlock = true; j++; continue; }
    if (c === '/' && n !== '/' && n !== '*' && /[=(,:[!&|?{};]\s*$/.test(line.slice(0, j))) { inRegex = true; continue; }
    if (c === "'" || c === '"') { inC = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '{') { depth++; stack.push(['{', li + 1]); }
    else if (c === '}') { depth--; stack.pop(); }
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
  }
  if (li >= 1790 && li <= 1830) console.log(li + 1, 'depth', depth, 'paren', paren, 'bracket', bracket);
}
console.log('final depth', depth, 'paren', paren, 'bracket', bracket);
console.log('open stack tail', JSON.stringify(stack.slice(-6)));
