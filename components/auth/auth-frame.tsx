import { Asterisk, LockKeyhole } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './auth-frame.module.css';

export function AuthFrame({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`${styles.frame} min-h-dvh bg-[#fafafa] text-foreground`}>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-7 sm:px-10">
        <Link
          href="/"
          className="flex items-center gap-2 text-[25px] font-semibold tracking-[-1px]"
          aria-label="Aster home"
        >
          <Asterisk className="size-8 text-primary" strokeWidth={1.7} />
          aster
        </Link>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5" />
          Private workspace
        </span>
      </header>
      <main
        className={`mx-auto px-5 pb-16 pt-10 sm:pt-16 ${wide ? 'max-w-3xl' : 'max-w-[450px]'}`}
      >
        <div className="mb-7">
          <h1 className="text-[27px] font-medium tracking-[-0.9px]">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
        {children}
        <p className="mt-9 text-xs leading-5 text-muted-foreground">
          Aster · Family office operations
        </p>
      </main>
    </div>
  );
}

export const fieldClass =
  'h-11 w-full rounded-md border border-input bg-white px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60';
export const primaryClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryClass =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-white px-3 text-sm text-foreground transition hover:bg-muted disabled:opacity-50';

export function AuthNotice({
  children,
  success = false,
}: {
  children: ReactNode;
  success?: boolean;
}) {
  return (
    <div
      role={success ? 'status' : 'alert'}
      className={`rounded-md border px-3 py-2.5 text-sm leading-5 ${success ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}
    >
      {children}
    </div>
  );
}
