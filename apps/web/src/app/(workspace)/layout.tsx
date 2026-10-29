import { apiRequest, requireIdentity } from '@/lib/auth';
import { readResponse, workspaceCountsSchema } from '@/lib/api-schemas';
import type { WorkspaceCounts } from '@/lib/navigation';
import { WorkspaceShell } from '@/components/workspace-shell';
import { ToastProvider } from '@/components/ui/toast';

// Counts are a convenience: if they fail to load, the workspace still opens without them.
async function workspaceCounts(): Promise<WorkspaceCounts | null> {
  try {
    const response = await apiRequest('workspace/counts');
    return response.ok ? await readResponse<WorkspaceCounts>(response, 'workspace counts', workspaceCountsSchema) : null;
  } catch { return null; }
}
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const [identity, counts] = await Promise.all([requireIdentity(), workspaceCounts()]);
  return <ToastProvider><WorkspaceShell identity={identity} counts={counts}>{children}</WorkspaceShell></ToastProvider>;
}
