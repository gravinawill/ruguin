import { type FastifyRequest } from 'fastify'

export type AuthenticatedTenant = Readonly<{ projectId: string; organizationId: string }>

export type AuthenticatedRequest = FastifyRequest & { authenticatedTenant?: AuthenticatedTenant }
