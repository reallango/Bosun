import { fetchWithAuth } from './fetchWithAuth';

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetchWithAuth(url);
  const json = await res.json();
  
  if (json.error) {
    throw new Error(json.error.message);
  }
  
  return json.data as T;
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  
  if (json.error) {
    throw new Error(json.error.message);
  }
  
  return json.data as T;
}

export async function apiPatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetchWithAuth(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  
  if (json.error) {
    throw new Error(json.error.message);
  }
  
  return json.data as T;
}

export async function apiDelete(url: string): Promise<void> {
  const res = await fetchWithAuth(url, { method: 'DELETE' });
  const json = await res.json();
  
  if (json.error) {
    throw new Error(json.error.message);
  }
}