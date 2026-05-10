'use strict';

const { config } = require('../config');

// ---------------------------------------------------------------------------
// GitHub REST API client using PAT authentication.
// Operations: read files, fetch diffs, create branches, commit, open PRs, merge.
// ---------------------------------------------------------------------------

const BASE = 'https://api.github.com';
const OWNER = config.github.owner;
const REPO = config.github.repo;

function headers() {
  return {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'smartops-agent/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}/repos/${OWNER}/${REPO}${path}`;
  const res = await fetch(url, { headers: headers(), ...opts });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------------------
// Get the last N commits with diffs.
// ---------------------------------------------------------------------------
async function getRecentDiffs(n = 5) {
  const commits = await ghFetch(`/commits?per_page=${n}`);
  const diffs = [];

  for (const c of commits) {
    const detail = await ghFetch(`/commits/${c.sha}`);
    diffs.push({
      sha: c.sha,
      message: c.commit?.message || '',
      author: c.commit?.author?.name || '',
      date: c.commit?.author?.date || '',
      files: (detail.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        patch: f.patch || '',
      })),
    });
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Get file content (decoded from base64).
// ---------------------------------------------------------------------------
async function getFileContent(path, branch) {
  const ref = branch || config.github.defaultBranch;
  const data = await ghFetch(`/contents/${encodeURIComponent(path)}?ref=${ref}`);
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return data.content || '';
}

// ---------------------------------------------------------------------------
// List all files in the repo (recursive tree).
// ---------------------------------------------------------------------------
async function listFiles(branch) {
  const ref = branch || config.github.defaultBranch;
  const data = await ghFetch(`/git/trees/${ref}?recursive=1`);
  return (data.tree || [])
    .filter((t) => t.type === 'blob')
    .map((t) => t.path);
}

// ---------------------------------------------------------------------------
// Get the SHA of a branch head.
// ---------------------------------------------------------------------------
async function getBranchSha(branch) {
  const ref = branch || config.github.defaultBranch;
  const data = await ghFetch(`/git/ref/heads/${ref}`);
  return data.object.sha;
}

// ---------------------------------------------------------------------------
// Create a new branch from a base SHA.
// ---------------------------------------------------------------------------
async function createBranch(branchName, baseSha) {
  return ghFetch('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
}

// ---------------------------------------------------------------------------
// Commit files to a branch.
// files: [{ path, content }]
// ---------------------------------------------------------------------------
async function commitFiles(branch, files, message) {
  // Get the current commit and tree
  const branchData = await ghFetch(`/git/ref/heads/${branch}`);
  const commitSha = branchData.object.sha;
  const commitData = await ghFetch(`/git/commits/${commitSha}`);
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeItems = [];
  for (const f of files) {
    const blob = await ghFetch('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create tree
  const tree = await ghFetch('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  // Create commit
  const newCommit = await ghFetch('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [commitSha],
      author: { name: 'SmartOps Agent', email: 'smartops@ammazone.dev', date: new Date().toISOString() },
    }),
  });

  // Update branch ref
  await ghFetch(`/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return newCommit.sha;
}

// ---------------------------------------------------------------------------
// Create a Pull Request.
// ---------------------------------------------------------------------------
async function createPR(branchName, title, body) {
  return ghFetch('/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title,
      body,
      head: branchName,
      base: config.github.defaultBranch,
    }),
  });
}

// ---------------------------------------------------------------------------
// Merge a Pull Request.
// ---------------------------------------------------------------------------
async function mergePR(prNumber) {
  return ghFetch(`/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash' }),
  });
}

module.exports = {
  getRecentDiffs,
  getFileContent,
  listFiles,
  getBranchSha,
  createBranch,
  commitFiles,
  createPR,
  mergePR,
};
