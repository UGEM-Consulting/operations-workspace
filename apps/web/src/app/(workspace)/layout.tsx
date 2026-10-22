import { requireIdentity } from '@/lib/auth';
import { WorkspaceShell } from '@/components/workspace-shell';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}>{children}</WorkspaceShell>;
}
