import { requireIdentity } from '@/lib/auth';
import { WorkspaceShell } from '@/components/workspace-shell';
import { ToastProvider } from '@/components/ui/toast';

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  return <ToastProvider><WorkspaceShell identity={identity}>{children}</WorkspaceShell></ToastProvider>;
}
