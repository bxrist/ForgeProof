import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSourceManifest } from "@/hooks/use-provenance";
import { githubLink, parseGithubSource } from "@/lib/provenance";

export function SourceManifestPanel({ id, filePath }: { id: string; filePath: string }) {
  const manifest = useSourceManifest(id);
  const [search, setSearch] = useState("");
  const data = manifest.data;
  const source = data?.source || parseGithubSource(filePath);
  const verified = !manifest.isError && !manifest.isFetching && !data?.pending && data?.status === "verified"
    && data.signatureValid === true && !!data.manifestHash && data.manifestHash === data.receiptHash;
  const files = (data?.files || []).filter(file => `${file.path} ${file.sha256}`.toLowerCase().includes(search.toLowerCase()));
  const commitUrl = githubLink(source?.commitUrl);
  const inventoryAvailable = !manifest.isError && !!data && !data.pending && data.status !== "unavailable";
  const fileCount = inventoryAvailable ? data.fileCount ?? data.files?.length : undefined;
  return (
    <Card className="p-6 space-y-4" data-testid="card-source-manifest">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <h3 className="font-semibold text-sm">Original source manifest</h3>
        <Badge variant="outline" className={verified ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
          {manifest.isFetching ? "Checking manifest" : data?.pending ? "Manifest pending" : verified ? "Manifest hash + signature verified" : manifest.isError ? "Unavailable — request failed" : data?.status === "unverified" || data?.status === "verified" ? "Unverified" : "Unavailable"}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Original source is separate from the optional Git receipt archive. Verification means the manifest hash matches the signed receipt and its signature is valid. It is not an audit of each file, AI authorship, or execution location.
      </p>
      {source && (
        <div className="text-sm space-y-2 break-all">
          <p>{source.owner}/{source.repo}{source.path ? ` · ${source.path}` : ""}</p>
          <p className="font-mono text-xs">Original commit: {source.commit}</p>
          {commitUrl && <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline text-xs">Open original source commit</a>}
        </div>
      )}
      {manifest.isLoading ? <Skeleton className="h-24 w-full" /> : manifest.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-muted-foreground">The manifest could not be retrieved. File count UNKNOWN. Access denied, authentication failures, and unavailable evidence are not verification passes.</p>
          <Button size="sm" variant="outline" onClick={() => manifest.refetch()}>Retry manifest request</Button>
        </div>
      ) : (
        <>
          {data?.reason && <p className="text-xs text-muted-foreground">{data.reason}</p>}
          <div className="text-xs space-y-2 break-all">
            <p><span className="text-muted-foreground">Manifest SHA-256: </span><code>{data?.manifestHash || "Unavailable"}</code></p>
            <p><span className="text-muted-foreground">Signed receipt hash: </span><code>{data?.receiptHash || "Unavailable"}</code></p>
            <p>{fileCount === undefined ? "File count UNKNOWN" : `${fileCount} files`} · one receipt signature, not one signature per file.</p>
          </div>
          <Input aria-label="Search source paths and SHA-256 hashes" placeholder="Search actual file paths or SHA-256 hashes…" value={search} onChange={event => setSearch(event.target.value)} />
          <p className="text-xs text-muted-foreground">{inventoryAvailable && data.files ? `${files.length} matching file records` : "File records unavailable; file count UNKNOWN"}</p>
          <div className="max-h-80 overflow-auto divide-y divide-border rounded-md border border-border">
            {files.length ? files.map((file, index) => (
              <div key={`${file.path}-${index}`} className="p-3 space-y-1">
                {source && verified ? <a className="block text-xs break-all text-primary underline"
                  href={`https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/blob/${encodeURIComponent(source.commit)}/${file.path.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank" rel="noopener noreferrer">{file.path}</a> : <p className="text-xs break-all">{file.path}</p>}
                <code className="block text-xs break-all text-muted-foreground">{file.sha256}</code>
              </div>
            )) : <p className="p-4 text-sm text-muted-foreground">{data?.files?.length ? "No files match your search." : "No file inventory is available. No file-level audit is implied."}</p>}
          </div>
        </>
      )}
    </Card>
  );
}
