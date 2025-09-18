"use client";

import { useEffect, useRef, useState } from "react";
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
  const [eventMediaById, setEventMediaById] = useState<Record<string, { url: string; kind: "image" | "video" } | null>>({});

  const isFirstLoadRef = useRef(true);
  const resolvingMediaIdsRef = useRef<Set<string>>(new Set());

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

  // Try to resolve media (image/video) for each alert's event id from Supabase Storage bucket 'falls'
  useEffect(() => {
    if (!alerts.length) return;

    const candidateImageExts = ["jpg"] as const;
    const candidateVideoExts = ["mov", "mp4", "webm"] as const;
    const candidateExts = [...candidateVideoExts,...candidateImageExts];

    function inferKindFromExt(ext: string): "image" | "video" {
      return (candidateImageExts as readonly string[]).includes(ext.toLowerCase()) ? "image" : "video";
    }

    async function urlExists(url: string): Promise<boolean> {
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (head.ok) return true;
      } catch {}
      try {
        const get = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
        return get.ok;
      } catch {
        return false;
      }
    }

    async function resolveMediaForEventId(eventId: string): Promise<{ url: string; kind: "image" | "video" } | null> {
      for (const ext of candidateExts) {
        const path = `${eventId}.${ext}`;
        // Try public URL first
        const publicUrl = supabase.storage.from("falls").getPublicUrl(path).data.publicUrl;
        if (publicUrl && (await urlExists(publicUrl))) {
          return { url: publicUrl, kind: inferKindFromExt(ext) };
        }
        // Fallback to signed URL (in case the bucket is private and policies allow signing client-side)
        try {
          const { data, error } = await supabase.storage.from("falls").createSignedUrl(path, 60 * 60);
          if (!error && data?.signedUrl) {
            if (await urlExists(data.signedUrl)) {
              return { url: data.signedUrl, kind: inferKindFromExt(ext) };
            }
          }
        } catch {}
      }
      return null;
    }

    const uniqueEventIds = Array.from(new Set(alerts.map(a => String(a.trigger_event))));
    uniqueEventIds.forEach(eventId => {
      if (eventMediaById[eventId] === undefined && !resolvingMediaIdsRef.current.has(eventId)) {
        resolvingMediaIdsRef.current.add(eventId);
        resolveMediaForEventId(eventId)
          .then(result => {
            setEventMediaById(prev => ({ ...prev, [eventId]: result }));
          })
          .finally(() => {
            resolvingMediaIdsRef.current.delete(eventId);
          });
      }
    });
  }, [alerts, supabase, eventMediaById]);

  function formatEventType(raw?: string): string {
    if (!raw) return "Unknown";
    return String(raw)
      .split("_")
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
       
        <h1>Bobo</h1>
        {user ? (
          <section className="w-full max-w-2xl mt-4">
            <h2 className="text-lg font-semibold mb-2">New Alerts</h2>
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
                          {formatEventType(a.event?.type)}
                        </p>
                        <p className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString()}</p>
                        <div className="mt-1">
                          <span className="inline-flex items-center rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-xs font-medium">Possibly Dead ☠️ 🪦</span>
                        </div>
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
                    {eventMediaById[String(a.trigger_event)] ? (
                      eventMediaById[String(a.trigger_event)]!.kind === "image" ? (
                        <img
                          src={eventMediaById[String(a.trigger_event)]!.url}
                          alt={`Event ${String(a.trigger_event)} media`}
                          className="mt-3 max-h-64 rounded border"
                        />
                      ) : (
                        <video
                          src={eventMediaById[String(a.trigger_event)]!.url}
                          controls
                          className="mt-3 max-h-64 rounded border"
                        />
                      )
                    ) : null}
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
