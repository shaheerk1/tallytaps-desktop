import { Injectable } from '@angular/core';
import { SessionService } from './session.service';

export type PriorityList = {
  id: number;
  name: string;
  isDefault: boolean;
  entries: string[];
  assignments: Array<{ targetType: 'role' | 'user'; targetId: number }>;
};

export type AssignmentTarget = {
  users: Array<{ id: number; username: string; displayName: string }>;
  roles: Array<{ id: number; roleKey: string; name: string }>;
};

@Injectable({ providedIn: 'root' })
export class PriorityListService {
  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async resolveForUser(userId: number): Promise<PriorityList | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.priorityLists.resolveForUser(userId);
    if (!result.success) return null;
    return result.data ?? null;
  }

  async list(): Promise<PriorityList[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.priorityLists.list(this.actor || undefined);
    if (!result.success) return [];
    return result.data || [];
  }

  async create(payload: {
    name: string;
    entries?: string[];
    isDefault?: boolean;
  }): Promise<PriorityList | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.priorityLists.create(payload, this.actor || undefined);
    if (!result.success) throw new Error(result.error || 'Failed to create priority list.');
    return result.data ?? null;
  }

  async update(
    id: number,
    payload: { name?: string; entries?: string[]; isDefault?: boolean }
  ): Promise<PriorityList | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.priorityLists.update(id, payload, this.actor || undefined);
    if (!result.success) throw new Error(result.error || 'Failed to update priority list.');
    return result.data ?? null;
  }

  async delete(id: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.priorityLists.delete(id, this.actor || undefined);
    return result.success && !!result.data?.deleted;
  }

  async setDefault(id: number): Promise<PriorityList | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.priorityLists.setDefault(id, this.actor || undefined);
    if (!result.success) throw new Error(result.error || 'Failed to set default list.');
    return result.data ?? null;
  }

  async setAssignments(
    listId: number,
    assignments: Array<{ targetType: 'role' | 'user'; targetId: number }>
  ): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.priorityLists.setAssignments(
      listId,
      assignments,
      this.actor || undefined
    );
    return result.success;
  }

  async assignmentTargets(): Promise<AssignmentTarget> {
    if (!window.posApi) return { users: [], roles: [] };
    const result = await window.posApi.priorityLists.assignmentTargets(this.actor || undefined);
    if (!result.success) return { users: [], roles: [] };
    return result.data || { users: [], roles: [] };
  }
}
