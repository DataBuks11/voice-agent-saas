import { extractiveAnswer } from "../apps/api/src/routes/conversations.js";

const hits = [
  { id: "1", workspaceId: "w", documentId: "d", content: "Unit-4 programme: Store student information in a file. Find the student with the highest marks. Display lines containing a specific word. Count lines, words and characters using file commands.", tokens: 0, metadata: {}, score: 0.31 },
  { id: "2", workspaceId: "w", documentId: "d", content: "Hash values are generated with the md5sum command and compared with cmp for file integrity verification during forensic acquisition.", tokens: 0, metadata: {}, score: 0.27 },
];
let fails = 0;
const check = (n: string, c: boolean, x = "") => { if (c) console.log(`  PASS  ${n} ${x}`); else { fails++; console.log(`  FAIL  ${n} ${x}`); } };

const a = extractiveAnswer("how do I find the student with the highest marks?", hits, 0.5);
check("lookup answered from the doc", /highest marks/i.test(a ?? ""), `-> ${a}`);
const b = extractiveAnswer("tell me about hash values", hits, 0.5);
check("second doc answered", /md5sum|hash/i.test(b ?? ""), `-> ${b}`);
const c = extractiveAnswer("what are you doing right now", hits, 0.5);
check("chit-chat is NOT answered from the doc", c === null, `-> ${c}`);
const d = extractiveAnswer("what is the capital of France", hits, 0.5);
check("unrelated question returns null", d === null, `-> ${d}`);
console.log(fails === 0 ? "\nEXTRACTIVE PASS" : `\nEXTRACTIVE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
