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
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [beepUrl, setBeepUrl] = useState<string | null>(null);

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

  function createBeepDataUrl({
    frequency = 880,
    durationSec = 0.35,
    sampleRate = 44100,
    volume = 0.4,
  } = {}): string {
    const numSamples = Math.floor(durationSec * sampleRate);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    function writeString(offset: number, str: string) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    // RIFF header
    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples * bytesPerSample, true);
    writeString(8, "WAVE");

    // fmt chunk
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample

    // data chunk
    writeString(36, "data");
    view.setUint32(40, numSamples * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * frequency * t) * volume;
      const s = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    const u8 = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    const base64 = typeof window === "undefined" ? "" : window.btoa(binary);
    return `data:audio/wav;base64,${base64}`;
  }

  async function enableSound() {
    const ctx = ensureAudioContext();
    if (ctx && ctx.state === "suspended") {
      try { await ctx.resume(); } catch {}
    }
    if (!beepUrl) {
      try { setBeepUrl(createBeepDataUrl()); } catch {}
    }
    setAudioUnlocked(true);
    setSoundEnabled(true);
    try { await playDing(); } catch {}
  }

  function disableSound() {
    setSoundEnabled(false);
  }

  async function playDing() {
    if (!soundEnabled) return;

    // Try Web Audio first
    try {
      const ctx = ensureAudioContext();
      if (ctx) {
        if (ctx.state === "suspended") {
          try { await ctx.resume(); } catch {}
        }
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 880; // A5
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.37);
        return;
      }
    } catch {}

    // Fallback to HTMLAudioElement if Web Audio fails or unavailable
    try {
      if (!beepUrl && typeof window !== "undefined") {
        setBeepUrl(createBeepDataUrl());
      }
      const el = audioElRef.current;
      if (el) {
        el.currentTime = 0;
        await el.play();
      }
    } catch {}
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
          if (hasNew) {
            try { await playDing(); } catch {}
          }
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
                  <>
                    <button onClick={disableSound} className="text-xs px-2 py-1 rounded border">Sound: On</button>
                    <button onClick={() => { playDing().catch(() => {}); }} className="text-xs px-2 py-1 rounded border">Test sound</button>
                  </>
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
            
            {beepUrl ? (
              <audio ref={audioElRef} src={beepUrl} preload="auto" className="hidden" />
            ) : null}

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
