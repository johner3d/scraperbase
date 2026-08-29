import path from 'node:path';

export function safeStoredPath(rootDirectory: string, storagePath: string): string | null {
  const root=path.resolve(rootDirectory),candidate=path.resolve(root,storagePath),relative=path.relative(root,candidate);
  return relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)?null:candidate;
}
