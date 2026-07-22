import { Octokit } from "@octokit/rest";

let connectionSettings: any;

async function getAccessToken() {
  if (
    connectionSettings &&
    connectionSettings.settings.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
  ) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("GitHub not connected. Please connect GitHub in the Replit integrations panel.");
  }

  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=github",
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    }
  )
    .then((res) => res.json())
    .then((data) => data.items?.[0]);

  const accessToken =
    connectionSettings?.settings?.access_token ||
    connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error("GitHub not connected. Please connect GitHub in the Replit integrations panel.");
  }
  return accessToken;
}

export async function getGitHubClient() {
  const accessToken = await getAccessToken();
  return new Octokit({ auth: accessToken });
}

export async function fetchUserRepos() {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: "updated",
    per_page: 100,
    type: "owner",
  });
  return data.map((repo) => ({
    githubId: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    defaultBranch: repo.default_branch || "main",
    description: repo.description || null,
  }));
}

export async function fetchRepoFiles(owner: string, repo: string, branch?: string) {
  const octokit = await getGitHubClient();
  const ref = branch || "main";

  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "1",
  });

  return data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => ({
      path: item.path!,
      sha: item.sha!,
      size: item.size || 0,
    }));
}

export async function fetchFileContent(owner: string, repo: string, path: string, ref?: string) {
  const octokit = await getGitHubClient();
  const params: any = { owner, repo, path };
  if (ref) params.ref = ref;

  const { data } = await octokit.repos.getContent(params);

  if ("content" in data && data.type === "file") {
    return {
      content: Buffer.from(data.content, "base64").toString("utf-8"),
      sha: data.sha,
      name: data.name,
      path: data.path,
      size: data.size,
    };
  }
  throw new Error("Not a file");
}

export async function fetchRepoCommits(owner: string, repo: string, since?: string, perPage = 30) {
  const octokit = await getGitHubClient();
  const params: any = { owner, repo, per_page: perPage };
  if (since) params.since = since;

  const { data } = await octokit.repos.listCommits(params);
  return data.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.commit.author?.name || "unknown",
    date: commit.commit.author?.date || new Date().toISOString(),
    filesUrl: commit.url,
  }));
}

export async function fetchCommitFiles(owner: string, repo: string, sha: string) {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.getCommit({ owner, repo, ref: sha });
  return (data.files || []).map((file) => ({
    filename: file.filename,
    status: file.status,
    sha: file.sha || "",
    patch: file.patch || "",
  }));
}

export async function commitAttestationToGit(
  token: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  entryHash: string,
  receiptJson: string,
  modelProvider: string,
  modelName: string
): Promise<string> {
  const filePath = `.forgeproof/receipts/${entryHash}.json`;
  const commitMessage = `chore: ForgeProof attestation ${entryHash.slice(0, 8)} — ${modelProvider}/${modelName}`;
  const contentBase64 = Buffer.from(receiptJson, "utf-8").toString("base64");

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  let existingSha: string | undefined;
  const getRes = await fetch(apiBase, { headers });
  if (getRes.ok) {
    const existing = await getRes.json() as any;
    existingSha = existing.sha;
  }

  const body: any = {
    message: commitMessage,
    content: contentBase64,
    branch: defaultBranch,
  };
  if (existingSha) body.sha = existingSha;

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub Contents API error ${putRes.status}: ${errText}`);
  }

  const result = await putRes.json() as any;
  return result.commit?.html_url as string;
}
