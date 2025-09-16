"use client";

import Link from "next/link";
import { getBrowserSupabaseClient } from "@/lib/supabaseClient";
import { useAuth } from "@/app/providers";

export default function Home() {
  const { user } = useAuth();
  const supabase = getBrowserSupabaseClient();

  async function signOut() {
    await supabase.auth.signOut();
  }
  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
       
        <h1>Robopet Dashboard</h1>
        {user ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">{user.email}</span>
            <button onClick={signOut} className="px-3 py-2 rounded border">Sign out</button>
          </div>
        ) : (
          <Link href="/login" className="px-3 py-2 rounded border">Login</Link>
        )}
        
      </main>
      
    </div>
  );
}
