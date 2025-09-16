'use client';

import { FormEvent, useEffect, useState } from 'react';
import { getBrowserSupabaseClient } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';

export default function LoginPage() {
  const router = useRouter();
  const { user } = useAuth();
  const supabase = getBrowserSupabaseClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      router.replace('/');
    }
  }, [user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
      if (data.session) {
        router.replace('/');
      }
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function onSignUp() {
    setError(null);
    setLoading(true);
    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signUpError) throw signUpError;
      router.replace('/');
    } catch (err: any) {
      setError(err?.message ?? 'Sign up failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Login</h1>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border rounded px-3 py-2"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border rounded px-3 py-2"
          required
        />
        {error ? <p className="text-red-600 text-sm">{error}</p> : null}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="px-3 py-2 rounded bg-black text-white disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Sign In'}
          </button>
          <button
            type="button"
            onClick={onSignUp}
            disabled={loading}
            className="px-3 py-2 rounded border disabled:opacity-50"
          >
            Create account
          </button>
        </div>
      </form>
    </div>
  );
}


