const fs = require("fs");

const SUBREDDIT = process.argv[2];
const LIMIT = 100;
const T = "all";
const USER_AGENT = "node:reddit-scraper:1.0 (analysis script)";
const OUT_FILE = `reddit-${SUBREDDIT}-top.json`;

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;

if (!SUBREDDIT) {
  console.error("Usage: node scrape-reddit.js <subreddit>");
  process.exit(1);
}

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`Auth failed: HTTP ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return json.access_token;
}

async function fetchTopPosts(subreddit) {
  const token = await getAccessToken();

  const baseUrl = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const url = `${baseUrl}/r/${subreddit}/top.json?t=${T}&limit=${LIMIT}`;

  const headers = { "User-Agent": USER_AGENT };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} — r/${subreddit} may not exist or is private`);
  }

  const json = await response.json();
  const children = json?.data?.children ?? [];

  if (children.length === 0) {
    console.warn(`Warning: r/${subreddit} returned 0 posts`);
    return [];
  }

  return children.map((child, i) => {
    const d = child.data;
    return {
      rank: i + 1,
      id: d.id,
      title: d.title,
      url: d.url,
      permalink: "https://reddit.com" + d.permalink,
      score: d.score,
      upvote_ratio: d.upvote_ratio,
      num_comments: d.num_comments,
      author: d.author,
      selftext: d.selftext,
      link_flair_text: d.link_flair_text ?? null,
      post_hint: d.post_hint ?? null,
      is_self: d.is_self,
      created_utc: d.created_utc,
      created_iso: new Date(d.created_utc * 1000).toISOString(),
    };
  });
}

function printSummaryTable(posts) {
  const COL = { rank: 4, score: 8, comments: 9, type: 8, title: 62 };

  const head = [
    "#".padEnd(COL.rank),
    "Score".padStart(COL.score),
    "Comments".padStart(COL.comments),
    "Type".padEnd(COL.type),
    "Title",
  ].join("  ");

  const sep = [
    "-".repeat(COL.rank),
    "-".repeat(COL.score),
    "-".repeat(COL.comments),
    "-".repeat(COL.type),
    "-".repeat(COL.title),
  ].join("  ");

  console.log("\n" + head);
  console.log(sep);

  for (const p of posts) {
    const type = p.post_hint ?? (p.is_self ? "self" : "link");
    const title = p.title.length > COL.title ? p.title.slice(0, COL.title - 3) + "..." : p.title;
    const row = [
      String(p.rank).padEnd(COL.rank),
      p.score.toLocaleString().padStart(COL.score),
      p.num_comments.toLocaleString().padStart(COL.comments),
      type.padEnd(COL.type),
      title,
    ].join("  ");
    console.log(row);
  }

  const scores = posts.map((p) => p.score).sort((a, b) => a - b);
  const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 0 ? Math.round((scores[mid - 1] + scores[mid]) / 2) : scores[mid];

  console.log(sep);
  console.log(
    `Total: ${posts.length} posts | Avg score: ${avg.toLocaleString()} | Median score: ${median.toLocaleString()}`
  );
}

(async () => {
  console.log(`Fetching top ${LIMIT} posts from r/${SUBREDDIT} (t=${T})...`);
  const posts = await fetchTopPosts(SUBREDDIT);

  fs.writeFileSync(OUT_FILE, JSON.stringify(posts, null, 2), "utf8");
  console.log(`Saved ${posts.length} posts to ${OUT_FILE}`);

  if (posts.length > 0) {
    printSummaryTable(posts);
  }
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
