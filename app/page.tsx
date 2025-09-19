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
  const isFirstPastLoadRef = useRef(true);

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
      if (isFirstPastLoadRef.current) setLoadingPastAlerts(true);
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
        if (isMounted && isFirstPastLoadRef.current) {
          setLoadingPastAlerts(false);
          isFirstPastLoadRef.current = false;
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900">
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-white/80 dark:bg-slate-900/80 border-b border-slate-200/60 dark:border-slate-700/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img 
                  src="/bobo.png" 
                  alt="Bobo" 
                  className="h-10 w-10 rounded-xl p-1 object-contain shadow-sm ring-2 ring-slate-200 dark:ring-slate-700" 
                />
                <div className="absolute -top-1 -right-1 h-4 w-4 bg-green-500 rounded-full border-2 border-white dark:border-slate-900 animate-pulse"></div>
              </div>
              <div>
                <h1 className="text-xl font-bold bg-gradient-to-r from-slate-900 to-slate-600 dark:from-white dark:to-slate-300 bg-clip-text text-transparent -mb-1">
                  Bobo
                </h1>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-green-700 dark:text-green-300">Active</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              {user ? (
                <div className="flex items-center gap-4">
                  <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                    <div className="h-2 w-2 bg-green-500 rounded-full"></div>
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate max-w-[160px]">
                      {user.email}
                    </span>
                  </div>
                  <button 
                    onClick={signOut} 
                    className="px-4 py-2 rounded-[100px] bg-slate-800 dark:bg-white text-white dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors duration-200 shadow-sm"
                  >
                    Menu
                  </button>
                </div>
              ) : (
                <Link 
                  href="/login" 
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors duration-200"
                >
                  Login
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1 w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {user ? (
            <>
              {/* Dashboard Header */}
              <div className="mb-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Grandpa's Alerts</h1>
                    <p className="text-sm text-slate-600 dark:text-slate-400">🏠 450 10th St, San Francisco, CA 94103</p>
                  </div>
                </div>
              </div>

              {/* Active Alerts Section */}
              <section className="mb-10">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                  <div
                    className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                      alerts.length > 0
                        ? "bg-red-100 dark:bg-red-900/30"
                        : "bg-slate-100 dark:bg-slate-900/30"
                    }`}
                  >
                    <svg
                      className={`h-4 w-4 ${
                        alerts.length > 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-slate-600 dark:text-slate-400"
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 18.5c-.77.833.192 2.5 1.732 2.5z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white"> {alerts.length} Active Alert{alerts.length === 1 ? '' : 's'} </h2>
                    </div>
                  </div>
                </div>
                {alertsError ? (
                  <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4">
                    <div className="flex items-center gap-3">
                      <svg className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-red-700 dark:text-red-300 font-medium">{alertsError}</p>
                    </div>
                  </div>
                ) : null}
                
                {loadingAlerts ? (
                  <div className="grid gap-4" aria-hidden>
                    {[...Array(2)].map((_, i) => (
                      <div key={i} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 shadow-sm">
                        <div className="animate-pulse">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="h-4 bg-slate-300 dark:bg-slate-600 rounded w-1/3 mb-2"></div>
                              <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2 mb-3"></div>
                              <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-20"></div>
                            </div>
                            <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-20"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : alerts.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="mx-auto h-16 w-16 rounded-full bg-slate-100 dark:bg-slate-900/30 flex items-center justify-center mb-4">
                      <svg className="h-8 w-8 text-slate-600 dark:text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">No active alerts at this time.</p>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {alerts.map(a => (
                      <div key={a.id} className="group rounded-2xl border border-red-200 dark:border-red-800 bg-white dark:bg-slate-800 shadow-sm hover:shadow-lg hover:border-red-300 dark:hover:border-red-700 transition-all duration-300">
                        <div className="p-6">
                          <div className="flex items-start justify-between gap-4 mb-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <div className="h-2 w-2 bg-red-500 rounded-full animate-pulse"></div>
                                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                                  {formatEventType(a.event?.type)}
                                </h3>
                              </div>
                              <div className="flex items-center gap-4 mb-3">
                                <div className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  <span className="text-sm">{new Date(a.created_at).toLocaleString()}</span>
                                </div>
                              </div>
                              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800">
                                <svg className="h-3 w-3 text-red-600 dark:text-red-400" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                </svg>
                                <span className="text-sm font-medium text-red-700 dark:text-red-300">Critical</span>
                              </div>
                            </div>
                            {a.status === "active" ? (
                              <button
                                onClick={() => dismissAlert(a.id)}
                                disabled={!!dismissingById[a.id]}
                                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                              >
                                {dismissingById[a.id] ? (
                                  <div className="flex items-center gap-2">
                                    <div className="h-4 w-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
                                    <span>Dismissing…</span>
                                  </div>
                                ) : (
                                  "Dismiss"
                                )}
                              </button>
                            ) : (
                              <span className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 text-sm font-medium capitalize">
                                {a.status}
                              </span>
                            )}
                          </div>
                          
                          {eventMediaById[String(a.trigger_event)] ? (
                            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm max-w-[600px] mx-auto">
                              <div className="aspect-16/9">
                                {eventMediaById[String(a.trigger_event)]!.kind === "image" ? (
                                  <img
                                    src={eventMediaById[String(a.trigger_event)]!.url}
                                    alt={`Event ${String(a.trigger_event)} media`}
                                  />
                                ) : (
                                  <video
                                    src={eventMediaById[String(a.trigger_event)]!.url}
                                    controls
                                  />
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Past Alerts Section */}
              <section>
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center">
                      <svg className="h-4 w-4 text-slate-600 dark:text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white">Past Alerts</h2>
                    </div>
                  </div>
                  {pastAlerts.length > 0 && (
                    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{pastAlerts.length} resolved</span>
                    </div>
                  )}
                </div>

                {pastAlertsError ? (
                  <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4">
                    <div className="flex items-center gap-3">
                      <svg className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-red-700 dark:text-red-300 font-medium">{pastAlertsError}</p>
                    </div>
                  </div>
                ) : null}

                {loadingPastAlerts ? (
                  <div className="grid gap-3" aria-hidden>
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
                        <div className="animate-pulse">
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex-1">
                              <div className="h-4 bg-slate-300 dark:bg-slate-600 rounded w-1/4 mb-2"></div>
                              <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/3"></div>
                            </div>
                            <div className="h-6 bg-slate-200 dark:bg-slate-700 rounded w-16"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : pastAlerts.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="mx-auto h-16 w-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
                      <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">No past alerts to display.</p>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {pastAlerts.map(a => (
                      <div key={a.id} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm hover:shadow-md transition-all duration-200">
                        <button
                          type="button"
                          onClick={() => togglePastExpanded(a.id, a.trigger_event)}
                          className="w-full p-4 flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-750 rounded-xl transition-colors duration-200"
                        >
                          <div className="flex items-center gap-3 text-left">
                            <div className="h-2 w-2 bg-slate-400 rounded-full"></div>
                            <div>
                              <p className="text-sm font-medium text-slate-900 dark:text-white">{formatEventType(a.event?.type)}</p>
                              <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span className="text-xs">{new Date(a.created_at).toLocaleString()}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-1 rounded-md bg-green-100 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 text-xs font-medium">
                              Resolved
                            </span>
                            <svg 
                              className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${expandedPastById[a.id] ? 'rotate-180' : ''}`} 
                              fill="none" 
                              viewBox="0 0 24 24" 
                              stroke="currentColor"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </button>
                        {expandedPastById[a.id] ? (
                          <div className="px-4 pb-4 border-t border-slate-200 dark:border-slate-700">
                            <div className="pt-4">
                              {eventMediaById[String(a.trigger_event)] ? (
                                <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm max-w-[600px] mx-auto">
                                  <div className="aspect-16/9">
                                    {eventMediaById[String(a.trigger_event)]!.kind === "image" ? (
                                      <img
                                        src={eventMediaById[String(a.trigger_event)]!.url}
                                        alt={`Event ${String(a.trigger_event)} media`}
                                      />
                                    ) : (
                                      <video
                                        src={eventMediaById[String(a.trigger_event)]!.url}
                                        controls
                                      />
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="h-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 animate-pulse flex items-center justify-center">
                                  <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  </svg>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            // Login prompt for non-authenticated users
            <div className="text-center py-20">
              <div className="mx-auto h-20 w-20 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-6">
                <img src="/bobo.png" alt="Bobo" className="h-12 w-12 rounded-lg object-contain" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">Welcome to Bobo</h1>
              <p className="text-slate-600 dark:text-slate-400 mb-8 max-w-md mx-auto">
                Your intelligent guardian assistant. Please log in to access your dashboard and monitor alerts.
              </p>
              <Link 
                href="/login" 
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors duration-200 shadow-sm"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                Get Started
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
