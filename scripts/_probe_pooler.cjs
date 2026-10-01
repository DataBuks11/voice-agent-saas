const pg = require("pg");

const regions = [
  "aws-0-ap-south-1",
  "aws-0-us-east-1",
  "aws-0-us-west-1",
  "aws-0-us-west-2",
  "aws-0-ap-southeast-1",
  "aws-0-ap-northeast-1",
  "aws-0-ap-northeast-2",
  "aws-0-ap-southeast-2",
  "aws-0-ca-central-1",
  "aws-0-eu-west-1",
  "aws-0-eu-west-2",
  "aws-0-eu-west-3",
  "aws-0-eu-central-1",
  "aws-0-sa-east-1",
];
const ports = [5432, 6543];
const user = "postgres.jszacqcjnqlyuhzubhkj";
const pass = "DataBuks@123#";

async function probe(host, port) {
  const client = new pg.Client({
    connectionString: `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/postgres?sslmode=no-verify`,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    const r = await client.query("select current_database()");
    await client.end();
    return `OK db=${r.rows[0].current_database}`;
  } catch (e) {
    try { await client.end(); } catch {}
    return `ERR ${e.message.slice(0, 80)}`;
  }
}

(async () => {
  for (const region of regions) {
    for (const port of ports) {
      const res = await probe(`${region}.pooler.supabase.com`, port);
      if (res.startsWith("OK")) console.log(`>>> ${region}:${port} ${res}`);
      else if (!/not found|ETIMEDOUT|ENOTFOUND|timeout/i.test(res)) console.log(`    ${region}:${port} ${res}`);
    }
  }
  console.log("scan done");
})();
