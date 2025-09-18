"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getBrowserSupabaseClient } from "@/lib/supabaseClient";
import { useAuth } from "@/app/providers";

const pollInterval = 3.5 * 1000;

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
  const [dismissingById, setDismissingById] = useState<Record<string, boolean>>({});

  const isFirstLoadRef = useRef(true);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const audioUnlockedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const dingBufferRef = useRef<AudioBuffer | null>(null);

  // Initialize AudioContext lazily for wider browser support
  useEffect(() => {
    if (typeof window === "undefined") return;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    audioContextRef.current = new AC();
  }, []);

  // Simple synthesized "ding" using WebAudio; avoids cross-origin and autoplay issues
  async function loadDingBuffer(ctx: AudioContext): Promise<AudioBuffer> {
    if (dingBufferRef.current) return dingBufferRef.current;
    // Synthesize a brief two-tone ping into an AudioBuffer
    const durationSec = 0.25;
    const sampleRate = ctx.sampleRate;
    const frameCount = Math.floor(durationSec * sampleRate);
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    const f1 = 880; // A5
    const f2 = 1320; // E6-ish
    for (let i = 0; i < frameCount; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-8 * t); // fast decay
      const s = 0.55 * Math.sin(2 * Math.PI * f1 * t) + 0.45 * Math.sin(2 * Math.PI * f2 * t);
      data[i] = s * env * 0.35; // keep it quiet
    }
    dingBufferRef.current = buffer;
    return buffer;
  }

  async function playDing() {
    try {
      const ctx = audioContextRef.current;
      if (!ctx) return;
      // Some browsers require a user gesture to start/resume the context
      if (ctx.state === "suspended" && audioUnlockedRef.current) {
        await ctx.resume();
      }
      const buffer = await loadDingBuffer(ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      source.connect(gain).connect(ctx.destination);
      source.start();
    } catch {
      // no-op; sound is best-effort
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function dismissAlert(alertId: string) {
    setAlertsError(null);
    setDismissingById(prev => ({ ...prev, [alertId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("dismiss-alert", {
        body: { alert_id: alertId },
      });

      if (error) throw error as any;

      // Optimistically remove the alert from the list
      setAlerts(prev => prev.filter(a => a.id !== alertId));
    } catch (err: any) {
      setAlertsError(err?.message ?? "Failed to dismiss alert");
    } finally {
      setDismissingById(prev => ({ ...prev, [alertId]: false }));
    }
  }

  useEffect(() => {
    // Reset seen alerts when user changes
    seenAlertIdsRef.current = new Set();
    isFirstLoadRef.current = true;
    const userId = user?.id;
    if (!userId) return;

    let isMounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function fetchAlertsOnce() {
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
        // Detect newly arrived alerts (by id) compared to last seen set
        if (!isFirstLoadRef.current) {
          const newOnes: string[] = [];
          for (const a of withEvents) {
            const id = String(a.id);
            if (!seenAlertIdsRef.current.has(id)) newOnes.push(id);
          }
          if (newOnes.length > 0) {
            // Mark as seen before playing sound to avoid double fires
            for (const id of newOnes) seenAlertIdsRef.current.add(id);
            // Play one ding for the batch to avoid cacophony
            playDing();
          }
        } else {
          // On first load, seed the seen set but do not play any sound
          seenAlertIdsRef.current = new Set(withEvents.map(a => String(a.id)));
        }

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

    fetchAlertsOnce();
    intervalId = setInterval(() => {
      fetchAlertsOnce();
    }, pollInterval);

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [user, supabase]);

  // Unlock audio on first user interaction to satisfy autoplay policies
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = async () => {
      audioUnlockedRef.current = true;
      const ctx = audioContextRef.current;
      try {
        if (ctx && ctx.state === "suspended") {
          await ctx.resume();
        }
      } catch {}
      window.removeEventListener("pointerdown", handler, { capture: true } as any);
      window.removeEventListener("keydown", handler, { capture: true } as any);
    };
    window.addEventListener("pointerdown", handler, { capture: true } as any);
    window.addEventListener("keydown", handler, { capture: true } as any);
    return () => {
      window.removeEventListener("pointerdown", handler, { capture: true } as any);
      window.removeEventListener("keydown", handler, { capture: true } as any);
    };
  }, []);

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
       
        <h1>Robopet Dashboard</h1>
        {user ? (
          <section className="w-full max-w-2xl mt-4">
            <h2 className="text-lg font-semibold mb-2">Alerts</h2>
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
                          <span className="font-medium"></span>{" "}
                          {a.event?.type ?? "Unknown"}
                        </p>
                        <p className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString()}</p>
                      </div>
                      {a.status === "active" ? (
                        <button
                          onClick={() => dismissAlert(a.id)}
                          disabled={!!dismissingById[a.id]}
                          className="text-xs px-2 py-1 rounded border disabled:opacity-50"
                        >
                          {dismissingById[a.id] ? "Dismissing…" : "Dismiss"}
                        </button>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded border capitalize">{a.status}</span>
                      )}
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
