import React from 'react'
import agent from 'api/apiAuth'

export default function Login() {
  const entrar = async (body) => agent.requests.post('Users/login', body)
  return <button onClick={() => entrar({})}>Entrar</button>
}
