/** A load board sign-in, and anyone else using it, so nobody closes the wrong account. */
export function SignIn({ email, others = [] }: { email: string; others?: { name: string }[] }) {
  return <><span className="block break-all">{email}</span>{others.length > 0 && <span className="block text-[13px] font-normal text-muted-foreground">Also used by {others.map(other => other.name).join(', ')}</span>}</>;
}
