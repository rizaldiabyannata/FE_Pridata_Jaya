import apiClient from "@/lib/api-client";

export type ProductCondition = "GOOD" | "DAMAGED";

export interface WarehouseInventoryItem {
	id: string;
	warehouseId: string;
	productId: string;
	condition: ProductCondition;
	quantity: number;
	createdAt?: string;
	updatedAt?: string;
	warehouse?: {
		id: string;
		name: string;
		address?: string;
		city?: {
			id: string;
			name: string;
		};
	};
	product?: {
		id: string;
		name: string;
		sku?: string | null;
		stockQuantity?: number;
		category?: {
			id: string;
			name: string;
		};
		brand?: {
			id: string;
			name: string;
		};
		division?: {
			id: string;
			name: string;
		};
		subDivision?: {
			id: string;
			name: string;
		};
	};
}

interface PaginationMeta {
	currentPage: number;
	totalPages: number;
	totalItems: number;
	itemsPerPage: number;
}

interface PaginatedApiResponse<T> {
	success: boolean;
	message: string;
	data: T[];
	meta: PaginationMeta;
}

interface ApiResponse<T> {
	success: boolean;
	message: string;
	data: T;
}

interface WarehouseInventoryListParams {
	page?: number;
	limit?: number;
	sortBy?: string;
	sortOrder?: "asc" | "desc";
	warehouseId?: string;
	productId?: string;
	condition?: ProductCondition;
	search?: string;
}

export type StockLevelStatus = "EMPTY" | "LOW" | "OK";

export interface StockLevelWarehouse {
	warehouseId: string;
	warehouseName: string;
	sellableQuantity: number;
	lastUpdatedAt: string;
	status: StockLevelStatus;
}

export interface StockLevel {
	productId: string;
	productName: string;
	productCode: string | null;
	categoryName: string | null;
	brandName: string | null;
	totalWarehouses: number;
	sellableQuantity: number;
	lastUpdatedAt: string;
	status: StockLevelStatus;
	warehouseBreakdown: StockLevelWarehouse[];
}

export interface StockLevelSummary {
	totalRows: number;
	totalSellableQuantity: number;
	lowStockRows: number;
	emptyRows: number;
	lowStockThreshold: number;
}

/** Satu pasangan produk-gudang dari `GET /warehouse-inventories/availability`. */
export interface StockAvailability {
	productId: string;
	warehouseId: string;
	/** Unit di gudang: GOOD + NEW, atau hanya kondisi yang diminta lewat `condition`. */
	onHand: number;
	/** Unit yang sudah di-pick/pack tapi belum dikirim oleh DO aktif dari gudang ini. */
	reservedByActiveDo: number;
	available: number;
}

/** Batas `productIds` per request di backend. */
const AVAILABILITY_BATCH_SIZE = 200;

export const availabilityKey = (warehouseId: string, productId: string) => `${warehouseId}:${productId}`;

export const indexAvailability = (rows: StockAvailability[]) =>
	new Map(rows.map((row) => [availabilityKey(row.warehouseId, row.productId), row]));

export interface StockLevelFilters {
	search?: string;
	warehouseId?: string;
	stockStatus?: StockLevelStatus;
}

export const warehouseInventoryService = {
	async stockLevels(
		params: StockLevelFilters & { page?: number; limit?: number },
	): Promise<{ items: StockLevel[]; meta?: PaginationMeta }> {
		const response = await apiClient.get<PaginatedApiResponse<StockLevel>>(
			"/warehouse-inventories/stock-levels",
			{ params },
		);
		return { items: response.data.data, meta: response.data.meta };
	},

	// Hanya filter: page/limit/sort ikut divalidasi backend dan tidak dibutuhkan ringkasan.
	async stockLevelsSummary(params: StockLevelFilters): Promise<StockLevelSummary> {
		const response = await apiClient.get<ApiResponse<StockLevelSummary>>(
			"/warehouse-inventories/stock-levels/summary",
			{ params },
		);
		return response.data.data;
	},

	/**
	 * Stok jual per produk-gudang untuk produk yang diminta saja. Tanpa `warehouseId` semua gudang
	 * (dalam cakupan akun) dikembalikan. Pasangan tanpa stok GOOD/NEW tidak ikut, artinya 0.
	 */
	async availability(productIds: string[], warehouseId?: string, condition?: "NEW" | "GOOD"): Promise<StockAvailability[]> {
		const ids = [...new Set(productIds)];
		const batches: string[][] = [];
		for (let start = 0; start < ids.length; start += AVAILABILITY_BATCH_SIZE) {
			batches.push(ids.slice(start, start + AVAILABILITY_BATCH_SIZE));
		}
		const responses = await Promise.all(
			batches.map((batch) =>
				apiClient.get<ApiResponse<StockAvailability[]>>("/warehouse-inventories/availability", {
					params: { productIds: batch.join(","), warehouseId, condition },
				}),
			),
		);
		return responses.flatMap((response) => response.data.data);
	},

	async list(
		params?: WarehouseInventoryListParams,
	): Promise<{ items: WarehouseInventoryItem[]; meta?: PaginationMeta }> {
		const response = await apiClient.get<PaginatedApiResponse<WarehouseInventoryItem>>(
			"/warehouse-inventories",
			{ params },
		);
		return { items: response.data.data, meta: response.data.meta };
	},

	async search(params: { search?: string; warehouseId?: string; condition?: ProductCondition }): Promise<WarehouseInventoryItem[]> {
		return (await this.list({ ...params, page: 1, limit: 10, sortBy: "name", sortOrder: "asc" })).items;
	},

	async create(payload: {
		warehouseId: string;
		productId: string;
		condition: ProductCondition;
		quantity: number;
	}): Promise<WarehouseInventoryItem> {
		const response = await apiClient.post<ApiResponse<WarehouseInventoryItem>>(
			"/warehouse-inventories",
			payload,
		);
		return response.data.data;
	},

	async adjust(
		id: string,
		payload: {
			quantity: number;
			reason: string;
		},
	): Promise<WarehouseInventoryItem> {
		const response = await apiClient.post<ApiResponse<WarehouseInventoryItem>>(
			`/warehouse-inventories/${id}/adjust`,
			payload,
		);
		return response.data.data;
	},
};
