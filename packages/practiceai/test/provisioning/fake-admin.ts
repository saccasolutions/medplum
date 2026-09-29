/**
 * In-memory stand-in for the super admin MedplumClient (unit tests only).
 * Implements just the search semantics provisioning relies on.
 */
import type { Project, ProjectMembership, Resource } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';
import type { AdminClient } from '../../src/provisioning/types';

type Stored = Resource & { id: string };

function matches(resource: Stored, key: string, value: string): boolean {
  const r = resource as unknown as Record<string, unknown>;
  switch (key) {
    case '_count':
      return true;
    case '_project':
      return resource.meta?.project === value;
    case 'identifier': {
      const [system, v] = value.split('|');
      const ids = (r.identifier ?? []) as { system?: string; value?: string }[];
      return (Array.isArray(ids) ? ids : [ids]).some((i) => i.system === system && i.value === v);
    }
    case 'name:exact':
      return r.name === value;
    case 'url':
    case 'version':
      return r[key] === value;
    case 'project':
    case 'user':
    case 'profile':
      return (r[key] as { reference?: string } | undefined)?.reference === value;
    default:
      throw new Error(`fake admin: unsupported search param ${key}`);
  }
}

export class FakeAdmin {
  readonly store = new Map<string, Stored>();
  writes = 0;
  superAdmin = true;

  all(type: string): Stored[] {
    return [...this.store.values()].filter((r) => r.resourceType === type);
  }

  private put<T extends Resource>(resource: T): T & { id: string } {
    const id = resource.id ?? randomUUID();
    const prior = this.store.get(`${resource.resourceType}/${id}`);
    const version = String(Number(prior?.meta?.versionId ?? '0') + 1);
    const project = resource.resourceType === 'Project' ? id : resource.meta?.project;
    const saved = structuredClone({ ...resource, id, meta: { ...resource.meta, versionId: version, ...(project ? { project } : {}) } }) as T & {
      id: string;
    };
    this.store.set(`${resource.resourceType}/${id}`, saved as Stored);
    this.writes++;
    return structuredClone(saved);
  }

  search(type: string, query: Record<string, string>): Stored[] {
    return this.all(type).filter((r) => Object.entries(query).every(([k, v]) => matches(r, k, v)));
  }

  client(): AdminClient {
    const self = this;
    const api = {
      getBaseUrl: () => 'http://fake-medplum.local/',
      getProject: () => ({ resourceType: 'Project', superAdmin: self.superAdmin }) as Project,
      searchResources: async (type: string, query: Record<string, string>) => structuredClone(self.search(type, query)),
      readResource: async (type: string, id: string) => {
        const r = self.store.get(`${type}/${id}`);
        if (!r) throw new Error('not found');
        return structuredClone(r);
      },
      createResource: async (resource: Resource) => self.put({ ...resource, id: undefined }),
      createResourceIfNoneExist: async (resource: Resource, query: string) => {
        const existing = self.search(resource.resourceType, Object.fromEntries(new URLSearchParams(query)));
        return existing[0] ? structuredClone(existing[0]) : self.put({ ...resource, id: undefined });
      },
      updateResource: async (resource: Resource) => {
        if (!resource.id || !self.store.has(`${resource.resourceType}/${resource.id}`)) throw new Error('update of missing resource');
        return self.put(resource);
      },
      post: async (url: string, body: Record<string, unknown>) => {
        const m = /^admin\/projects\/([^/]+)\/(client|invite)$/.exec(url);
        if (!m) throw new Error(`fake admin: unsupported POST ${url}`);
        const projectId = m[1] as string;
        const project = { reference: `Project/${projectId}` };
        if (m[2] === 'client') {
          const client = self.put({
            resourceType: 'ClientApplication',
            name: body.name as string,
            description: body.description as string,
            secret: randomUUID().replaceAll('-', ''),
            meta: { project: projectId },
          });
          self.put<ProjectMembership>({
            resourceType: 'ProjectMembership',
            meta: { project: projectId },
            project,
            user: { reference: `ClientApplication/${client.id}` },
            profile: { reference: `ClientApplication/${client.id}` },
            accessPolicy: body.accessPolicy as ProjectMembership['accessPolicy'],
          });
          return client;
        }
        const membership = body.membership as Partial<ProjectMembership>;
        if (self.search('ProjectMembership', { project: project.reference, profile: membership.profile?.reference ?? '' }).length > 0) {
          throw new Error('User is already a member of this project');
        }
        const user = self.put({ resourceType: 'User', email: body.email as string, meta: { project: projectId } } as Resource);
        return self.put<ProjectMembership>({
          resourceType: 'ProjectMembership',
          meta: { project: projectId },
          project,
          user: { reference: `User/${user.id}` },
          profile: membership.profile as ProjectMembership['profile'],
          accessPolicy: membership.accessPolicy,
          admin: membership.admin,
        });
      },
    };
    return api as unknown as AdminClient;
  }
}
