import type { Metadata } from 'next';
export const metadata:Metadata={title:'Dispatcher application',robots:{index:false,follow:false},referrer:'no-referrer'};
export default function Layout({children}:{children:React.ReactNode}) {return <main className="min-h-screen bg-background px-4 py-10 text-foreground"><div className="mx-auto max-w-3xl"><p className="mb-8 text-sm font-semibold tracking-wide">OPERATIONS WORKSPACE</p>{children}</div></main>;}
