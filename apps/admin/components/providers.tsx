'use client';

import { AuthProvider } from '@media/auth-client';
import type { PropsWithChildren } from 'react';

export function Providers({ children }: PropsWithChildren) {
  return <AuthProvider>{children}</AuthProvider>;
}
