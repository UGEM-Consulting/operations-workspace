export async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown = {}) {
  const response = await fetch(`/api/backend/${path}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-protection': '1' }, body: JSON.stringify(body) });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'Request failed');
  return data;
}
