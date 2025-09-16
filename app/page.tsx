"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getBrowserSupabaseClient } from "@/lib/supabaseClient";
import { useAuth } from "@/app/providers";

export default function Home() {
  const { user } = useAuth();
  const supabase = getBrowserSupabaseClient();

  type AlertRow = {
    id: string;
    created_at: string;
    status: string;
    trigger_event: string | number;
    user_id: string;
  };
  type EventRow = { id: string | number; type: string };
  type AlertWithEvent = AlertRow & { event: EventRow | null };

  const [alerts, setAlerts] = useState<AlertWithEvent[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);

  const knownAlertIdsRef = useRef<Set<string>>(new Set());
  const isFirstLoadRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);

  async function signOut() {
    await supabase.auth.signOut();
  }

  function ensureAudioContext(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!AC) return null;
        audioCtxRef.current = new AC();
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }

  async function enableSound() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      // Play a very short, quiet blip to finalize unlock on some browsers
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 600;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.08);
    } catch {}
    setAudioUnlocked(true);
    setSoundEnabled(true);
  }

  function disableSound() {
    setSoundEnabled(false);
  }

  function playDing() {
    if (!soundEnabled || !audioUnlocked) return;
    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        // If suspended and no prior unlock, skip silently; user must enable
        ctx.resume().catch(() => {});
      }
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880; // A5
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.22);
    } catch {
      // ignore audio errors
    }
  }

  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;

    let isMounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function fetchAlertsOnce({ shouldSignalNew }: { shouldSignalNew: boolean }) {
      if (!isMounted) return;
      setAlertsError(null);
      if (isFirstLoadRef.current) setLoadingAlerts(true);
      try {
        const { data: alertsData, error: alertsErr } = await supabase
          .from("alerts")
          .select("id, created_at, status, trigger_event, user_id")
          .eq("user_id", userId)
          .neq("status", "dismissed")
          .order("created_at", { ascending: false });

        if (alertsErr) throw alertsErr;
        const baseAlerts = (alertsData ?? []) as AlertRow[];

        const eventIds = baseAlerts.length
          ? Array.from(new Set(baseAlerts.map(a => a.trigger_event)))
          : [];

        let eventsById = new Map<string, EventRow>();
        if (eventIds.length > 0) {
          const { data: eventsData, error: eventsErr } = await supabase
            .from("events")
            .select("id, type")
            .in("id", eventIds);
          if (eventsErr) throw eventsErr;
          eventsById = new Map<string, EventRow>((eventsData ?? []).map((e: any) => [String(e.id), e as EventRow]));
        }

        const withEvents: AlertWithEvent[] = baseAlerts.map(a => ({
          ...a,
          event: eventsById.get(String(a.trigger_event)) ?? null,
        }));

        if (!isMounted) return;

        // Detect new alerts by id
        const currentIds = new Set(withEvents.map(a => a.id));
        if (!isFirstLoadRef.current && shouldSignalNew) {
          let hasNew = false;
          for (const id of currentIds) {
            if (!knownAlertIdsRef.current.has(id)) {
              hasNew = true;
              break;
            }
          }
          if (hasNew) playDing();
        }
        knownAlertIdsRef.current = currentIds;

        setAlerts(withEvents);
      } catch (err: any) {
        if (isMounted) setAlertsError(err?.message ?? "Failed to load alerts");
      } finally {
        if (isMounted && isFirstLoadRef.current) {
          setLoadingAlerts(false);
          isFirstLoadRef.current = false;
        }
      }
    }

    // Initial fetch, don't ding
    fetchAlertsOnce({ shouldSignalNew: false });
    // Poll every 5 seconds, ding if new
    intervalId = setInterval(() => {
      fetchAlertsOnce({ shouldSignalNew: true });
    }, 5000);

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [user, supabase]);

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
       
        <h1>Robopet Dashboard</h1>
        {user ? (
          <section className="w-full max-w-2xl mt-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">Alerts</h2>
              <div className="flex items-center gap-2">
                {audioUnlocked && soundEnabled ? (
                  <button onClick={disableSound} className="text-xs px-2 py-1 rounded border">Sound: On</button>
                ) : (
                  <button onClick={enableSound} className="text-xs px-2 py-1 rounded border">Enable sound</button>
                )}
              </div>
            </div>
            {alertsError ? (
              <p className="text-red-600 text-sm">{alertsError}</p>
            ) : null}
            {loadingAlerts ? (
              <p className="text-sm text-gray-600">Loading alerts…</p>
            ) : alerts.length === 0 ? (
              <p className="text-sm text-gray-600">No alerts.</p>
            ) : (
              <ul className="space-y-2">
                {alerts.map(a => (
                  <li key={a.id} className="border rounded p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm">
                          <span className="font-medium">Event Type:</span>{" "}
                          {a.event?.type ?? "Unknown"}
                        </p>
                        <p className="text-xs text-gray-500">Created {new Date(a.created_at).toLocaleString()}</p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded border capitalize">{a.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            
          </section>
        ) : null}
        
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
