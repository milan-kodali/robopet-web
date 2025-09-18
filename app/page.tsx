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
  const [pastAlerts, setPastAlerts] = useState<AlertWithEvent[]>([]);
  const [loadingPastAlerts, setLoadingPastAlerts] = useState(false);
  const [pastAlertsError, setPastAlertsError] = useState<string | null>(null);
  const [expandedPastById, setExpandedPastById] = useState<Record<string, boolean>>({});

  const isFirstLoadRef = useRef(true);
  const resolvingMediaIdsRef = useRef<Set<string>>(new Set());

  // Media resolution helpers reused by active and past alerts
  const candidateImageExts = ["jpg"] as const;
  const candidateVideoExts = ["mov"] as const;
  const candidateExts = [...candidateVideoExts, ...candidateImageExts] as const;

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
    for (const ext of candidateExts as readonly string[]) {
      const path = `${eventId}.${ext}`;
      const publicUrl = supabase.storage.from("falls").getPublicUrl(path).data.publicUrl;
      if (publicUrl && (await urlExists(publicUrl))) {
        return { url: publicUrl, kind: inferKindFromExt(ext) };
      }
    }
    return null;
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

  // Resolve media for active alerts only
  useEffect(() => {
    if (!alerts.length) return;
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
  }, [alerts, resolveMediaForEventId, eventMediaById]);

  // Fetch dismissed (past) alerts
  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;

    let isMounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function fetchPastAlertsOnce() {
      if (!isMounted) return;
      setPastAlertsError(null);
      if (isFirstLoadRef.current) setLoadingPastAlerts(true);
      try {
        const { data: alertsData, error: alertsErr } = await supabase
          .from("alerts")
          .select("id, created_at, status, trigger_event, user_id")
          .eq("user_id", userId)
          .eq("status", "dismissed")
          .order("created_at", { ascending: false })
          .limit(50);

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
        setPastAlerts(withEvents);
      } catch (err: any) {
        if (isMounted) setPastAlertsError(err?.message ?? "Failed to load past alerts");
      } finally {
        if (isMounted && isFirstLoadRef.current) {
          setLoadingPastAlerts(false);
        }
      }
    }

    fetchPastAlertsOnce();
    intervalId = setInterval(() => {
      fetchPastAlertsOnce();
    }, pollInterval);

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [user, supabase]);

  function togglePastExpanded(alertId: string, eventId: string | number) {
    setExpandedPastById(prev => {
      const nextExpanded = !prev[alertId];
      const updated = { ...prev, [alertId]: nextExpanded };
      const key = String(eventId);
      if (nextExpanded && eventMediaById[key] === undefined && !resolvingMediaIdsRef.current.has(key)) {
        resolvingMediaIdsRef.current.add(key);
        resolveMediaForEventId(key)
          .then(result => {
            setEventMediaById(prevMap => ({ ...prevMap, [key]: result }));
          })
          .finally(() => {
            resolvingMediaIdsRef.current.delete(key);
          });
      }
      return updated;
    });
  }

  function formatEventType(raw?: string): string {
    if (!raw) return "Unknown";
    return String(raw)
      .split("_")
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return (
    <div className="font-sans min-h-screen flex flex-col bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-10 border-b bg-[var(--background)]/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-black text-white text-xs font-semibold">B</span>
            <span className="font-semibold tracking-tight">Bobo</span>
          </div>
          <div>
            {user ? (
              <div className="flex items-center gap-3">
                <span className="hidden sm:block text-sm text-gray-600 truncate max-w-[160px]">{user.email}</span>
                <button onClick={signOut} className="px-3 py-2 rounded-md bg-black text-white hover:bg-black/90">Sign out</button>
              </div>
            ) : (
              <Link href="/login" className="px-3 py-2 rounded-md border hover:bg-gray-50">Login</Link>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 w-full">
        <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
        {user ? (
          <section className="w-full mt-4">
            <h2 className="text-base font-semibold mb-2 text-gray-700">New Alerts</h2>
            {alertsError ? (
              <p className="text-red-600 text-sm">{alertsError}</p>
            ) : null}
            {loadingAlerts ? (
              <div className="mt-3 space-y-3" aria-hidden>
                <div className="h-24 rounded-xl border bg-gray-100/60 dark:bg-neutral-800/60 animate-pulse" />
                <div className="h-24 rounded-xl border bg-gray-100/60 dark:bg-neutral-800/60 animate-pulse" />
              </div>
            ) : alerts.length === 0 ? (
              <div className="mt-3 rounded-xl border p-6 text-center text-sm text-gray-600">No alerts.</div>
            ) : (
              <ul className="space-y-3">
                {alerts.map(a => (
                  <li key={a.id} className="rounded-xl border p-4 bg-white/50 dark:bg-neutral-900/50 shadow-sm hover:shadow-md transition">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium">{formatEventType(a.event?.type)}</p>
                        <p className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString()}</p>
                        <div className="mt-2">
                          <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 text-xs font-medium">Dangerous</span>
                        </div>
                      </div>
                      {a.status === "active" ? (
                        <button
                          onClick={() => dismissAlert(a.id)}
                          disabled={!!dismissingById[a.id]}
                          className="text-xs px-2 py-1 rounded-md border hover:bg-gray-50 disabled:opacity-50"
                        >
                          {dismissingById[a.id] ? "Dismissing…" : "Dismiss"}
                        </button>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded-md border capitalize">{a.status}</span>
                      )}
                    </div>
                    {eventMediaById[String(a.trigger_event)] ? (
                      eventMediaById[String(a.trigger_event)]!.kind === "image" ? (
                        <img
                          src={eventMediaById[String(a.trigger_event)]!.url}
                          alt={`Event ${String(a.trigger_event)} media`}
                          className="mt-3 max-h-64 rounded-lg border"
                        />
                      ) : (
                        <video
                          src={eventMediaById[String(a.trigger_event)]!.url}
                          controls
                          className="mt-3 max-h-64 rounded-lg border"
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
          <section className="w-full mt-8">
            <h2 className="text-base font-semibold mb-2 text-gray-700">Past Alerts</h2>
            {pastAlertsError ? (
              <p className="text-red-600 text-sm">{pastAlertsError}</p>
            ) : null}
            {loadingPastAlerts ? (
              <div className="mt-3 space-y-3" aria-hidden>
                <div className="h-16 rounded-xl border bg-gray-100/60 dark:bg-neutral-800/60 animate-pulse" />
                <div className="h-16 rounded-xl border bg-gray-100/60 dark:bg-neutral-800/60 animate-pulse" />
              </div>
            ) : pastAlerts.length === 0 ? (
              <div className="mt-3 rounded-xl border p-6 text-center text-sm text-gray-600">No past alerts.</div>
            ) : (
              <ul className="space-y-3">
                {pastAlerts.map(a => (
                  <li key={a.id} className="rounded-xl border bg-white/50 dark:bg-neutral-900/50">
                    <button
                      type="button"
                      onClick={() => togglePastExpanded(a.id, a.trigger_event)}
                      className="w-full p-4 flex items-start justify-between gap-4 hover:bg-gray-50 rounded-xl"
                    >
                      <div className="text-left">
                        <p className="text-sm font-medium">{formatEventType(a.event?.type)}</p>
                        <p className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString()}</p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded-md border capitalize">{a.status}</span>
                    </button>
                    {expandedPastById[a.id] ? (
                      <div className="px-4 pb-4">
                        {eventMediaById[String(a.trigger_event)] ? (
                          eventMediaById[String(a.trigger_event)]!.kind === "image" ? (
                            <img
                              src={eventMediaById[String(a.trigger_event)]!.url}
                              alt={`Event ${String(a.trigger_event)} media`}
                              className="mt-3 max-h-64 rounded-lg border"
                            />
                          ) : (
                            <video
                              src={eventMediaById[String(a.trigger_event)]!.url}
                              controls
                              className="mt-3 max-h-64 rounded-lg border"
                            />
                          )
                        ) : (
                          <div className="mt-3 h-24 rounded-xl border bg-gray-100/60 dark:bg-neutral-800/60 animate-pulse" />
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        </div>
      </main>
    </div>
  );
}
