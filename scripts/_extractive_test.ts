import { extractiveAnswer, looksLikeHeading } from "../apps/api/src/routes/conversations.js";

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
check("code fragment rejected", extractiveAnswer("how do I find the student with the highest marks?", [
  { id: "1", workspaceId: "w", documentId: "d", content: 'printf("File copied successfully.")', tokens: 0, metadata: {}, score: 0.3 },
], 0.5) === null, "");
const d = extractiveAnswer("what is the capital of France", hits, 0.5);
check("unrelated question returns null", d === null, `-> ${d}`);
// Headings overlap the question but are not answers.
const headingHits = [
  { id: "3", workspaceId: "w", documentId: "d", content: "Count Number of Lines in a File\nStore Student Information in a File", tokens: 0, metadata: {}, score: 0.4 },
];
check(
  "bare heading is rejected",
  extractiveAnswer("how do I count lines in a file?", headingHits, 0.5) === null,
  `-> ${extractiveAnswer("how do I count lines in a file?", headingHits, 0.5)}`,
);
check("heading detector flags a noun phrase", looksLikeHeading("Count Number of Lines in a File"));
check("heading detector keeps a statement", !looksLikeHeading("Hash values are generated with the md5sum command."));
check("heading detector keeps a short imperative", !looksLikeHeading("Find the student with the highest marks."));

console.log(fails === 0 ? "\nEXTRACTIVE PASS" : `\nEXTRACTIVE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
