const BASE: string = import.meta.env.VITE_API_ROLES as string

export interface Role { id: string }

export const listarRoles = async (): Promise<Role[]> => {
  const res = await fetch(`${BASE}/roles`)
  return (await res.json()) as Role[]
}

export async function apagarRole(id: string): Promise<void> {
  await fetch(`${BASE}/roles/${id}`, { method: 'DELETE' })
}
