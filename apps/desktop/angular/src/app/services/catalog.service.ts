import { Injectable } from '@angular/core';
import { SessionService } from './session.service';
import type { CatalogProduct, CatalogProductInput } from '../../../../../../packages/shared/ipc/pos-api';

@Injectable({ providedIn: 'root' })
export class CatalogService {
  constructor(private session: SessionService) {}

  private get actor(): { id: string; permissions: string[] } | null {
    return this.session.getActor();
  }

  async list(includeInactive = false): Promise<CatalogProduct[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.catalog.listProducts({ includeInactive });
    if (!result.success) return [];
    return result.data as unknown as CatalogProduct[];
  }

  async listActive(): Promise<CatalogProduct[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.catalog.listProducts();
    if (!result.success) return [];
    return result.data as unknown as CatalogProduct[];
  }

  async categories(): Promise<string[]> {
    if (!window.posApi) return [];
    const result = await window.posApi.catalog.listProductCategories();
    if (!result.success) return [];
    return result.data as unknown as string[];
  }

  async create(payload: CatalogProductInput): Promise<CatalogProduct | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.catalog.createProduct(payload, this.actor);
    if (!result.success) return null;
    return result.data as unknown as CatalogProduct;
  }

  async update(id: number, updates: Partial<CatalogProductInput>): Promise<CatalogProduct | null> {
    if (!window.posApi) return null;
    const result = await window.posApi.catalog.updateProduct(id, updates, this.actor);
    if (!result.success) return null;
    return result.data as unknown as CatalogProduct;
  }

  async delete(id: number): Promise<boolean> {
    if (!window.posApi) return false;
    const result = await window.posApi.catalog.deleteProduct(id, this.actor);
    return result.success;
  }
}
