// src/lib/api/fetchWithAuth.ts
'use client';

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        return res.ok;
    } catch {
        return false;
    }
}

export async function fetchWithAuth(
    url: string,
    options?: RequestInit
): Promise<Response> {
    let res = await fetch(url, options);

    if (res.status === 401) {
        // Avoid multiple simultaneous refresh attempts
        if (!isRefreshing) {
            isRefreshing = true;
            refreshPromise = attemptRefresh();
        }

        const refreshed = await refreshPromise;
        isRefreshing = false;
        refreshPromise = null;

        if (refreshed) {
            // Retry the original request with new token
            res = await fetch(url, options);
        } else {
            // Refresh failed - redirect to login
            if (typeof window !== 'undefined') {
                window.location.href = '/login';
            }
        }
    }

    return res;
}