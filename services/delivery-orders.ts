import apiClient from "@/lib/api-client";
import { collectPaginatedItems } from "@/services/pagination";
import { availabilityKey, type StockAvailability } from "@/services/warehouse-inventory";

export type DeliveryOrderStatus =
	| "OPEN"
	| "PICKING"
	| "PACKING"
	| "READY_TO_SHIP"
	| "PARTIALLY_SHIPPED"
	| "SHIPPED"
	| "RECEIVED"
	| "CANCELLED";

export interface DeliveryOrderListItem {
	id: string;
	deliveryOrderNumber: string;
	documentDate: string;
	status: DeliveryOrderStatus;
	invoiceId?: string | null;
	storeId: string;
	sourceWarehouseId: string;
	storeNameSnapshot: string;
	totalItems?: number;
	notes?: string | null;
	receivedAt?: string | null;
	receiptNotes?: string | null;
	cancelReason?: string | null;
	cancelledAt?: string | null;
	replacementForReturn?: {
		id: string;
		returnNumber: string;
		status: string;
		reason?: string | null;
	} | null;
	items: Array<{
		id: string;
		productId: string;
		condition: "GOOD" | "DAMAGED";
		orderedQuantity: number;
		pickedQuantity: number;
		packedQuantity: number;
		shippedQuantity: number;
		product?: {
			name: string;
		};
	}>;
	shipments: Array<{
		id: string;
		shippedAt: string;
		driverId?: string | null;
		driverName?: string | null;
		driverNameSnapshot?: string | null;
		driverPhoneSnapshot?: string | null;
		driver?: {
			id: string;
			name: string;
			phone?: string | null;
			isActive?: boolean;
		} | null;
		notes?: string | null;
	}>;
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

interface DeliveryOrderListParams {
	page?: number;
	limit?: number;
	sortBy?: "documentDate" | "status" | "createdAt" | "updatedAt";
	sortOrder?: "asc" | "desc";
	/** Beberapa status dikirim sebagai satu daftar dipisah koma. */
	status?: DeliveryOrderStatus | DeliveryOrderStatus[];
	storeId?: string;
	sourceWarehouseId?: string;
	invoiceId?: string;
	search?: string;
}

export type DeliveryOrderSummaryFilters = Pick<
	DeliveryOrderListParams,
	"status" | "storeId" | "sourceWarehouseId" | "search"
>;

export interface DeliveryOrderWarehouseSummary {
	warehouseId: string;
	warehouseName: string;
	totalDo: number;
	/** Status selain SHIPPED, RECEIVED, CANCELLED. */
	activeDo: number;
	shippedDo: number;
	totalItemsShipped: number;
}

export interface DeliveryOrderDriverSummary {
	driverName: string;
	totalShipments: number;
	totalDo: number;
	lastShippedAt: string | null;
}

/** DO yang belum selesai dikirim (sama dengan tab "Isi Driver"). */
export const ACTIVE_DELIVERY_ORDER_STATUSES: DeliveryOrderStatus[] = [
	"OPEN",
	"PICKING",
	"PACKING",
	"READY_TO_SHIP",
	"PARTIALLY_SHIPPED",
];

/** Status yang menahan stok di `availableStockCte` backend (OPEN belum menahan). */
const RESERVING_STATUSES: DeliveryOrderStatus[] = ["PICKING", "PACKING", "READY_TO_SHIP", "PARTIALLY_SHIPPED"];

const withStatusList = <T extends { status?: DeliveryOrderStatus | DeliveryOrderStatus[] }>(params?: T) =>
	params && Array.isArray(params.status) ? { ...params, status: params.status.join(",") } : params;

/**
 * Stok yang bisa dipakai untuk mengirim `productId` dari DO ini. `reservedByActiveDo` di server
 * sudah ikut menahan barang yang di-pick/pack oleh DO ini sendiri, jadi bagian itu dikembalikan.
 * Baris yang tidak ada di respons ketersediaan berarti stok 0.
 */
export const shippableStock = (
	deliveryOrder: Pick<DeliveryOrderListItem, "status" | "items">,
	productId: string,
	row?: StockAvailability,
) => {
	if (!row) return 0;
	if (!RESERVING_STATUSES.includes(deliveryOrder.status)) return row.available;
	const ownReserved = deliveryOrder.items
		.filter((item) => item.productId === productId)
		.reduce(
			(sum, item) =>
				sum + Math.max(Math.max(item.pickedQuantity, item.packedQuantity) - item.shippedQuantity, 0),
			0,
		);
	return Math.max(row.onHand - row.reservedByActiveDo + ownReserved, 0);
};

/**
 * Gudang pengirim untuk satu pesanan, diurutkan dari stok jual terbanyak. Hanya item GOOD
 * yang bisa dikirim lewat DO; item lain dihitung sebagai kekurangan.
 */
export const rankSourceWarehouses = (
	orderItems: Array<{ productId: string; condition: string; quantity: number }>,
	warehouses: Array<{ id: string; name: string }>,
	stock: Map<string, StockAvailability>,
) => {
	if (orderItems.length === 0) return [];
	return warehouses
		.map((warehouse) => {
			const available = orderItems.map((item) =>
				item.condition === "GOOD" ? stock.get(availabilityKey(warehouse.id, item.productId))?.available ?? 0 : 0,
			);
			return {
				id: warehouse.id,
				name: warehouse.name,
				shortfallCount: orderItems.filter((item, index) => available[index] < item.quantity).length,
				totalAvailable: available.reduce((sum, value) => sum + value, 0),
			};
		})
		.sort((left, right) => right.totalAvailable - left.totalAvailable);
};

export const deliveryOrdersService = {
	async list(
		params?: DeliveryOrderListParams,
	): Promise<{ items: DeliveryOrderListItem[]; meta?: PaginationMeta }> {
		const response = await apiClient.get<PaginatedApiResponse<DeliveryOrderListItem>>(
			"/delivery-orders",
			{ params: withStatusList(params) },
		);
		return { items: response.data.data, meta: response.data.meta };
	},

	async summaryByWarehouse(filters?: DeliveryOrderSummaryFilters): Promise<DeliveryOrderWarehouseSummary[]> {
		const response = await apiClient.get<ApiResponse<DeliveryOrderWarehouseSummary[]>>(
			"/delivery-orders/summary",
			{ params: { ...withStatusList(filters), groupBy: "warehouse" } },
		);
		return response.data.data;
	},

	async summaryByDriver(filters?: DeliveryOrderSummaryFilters): Promise<DeliveryOrderDriverSummary[]> {
		const response = await apiClient.get<ApiResponse<DeliveryOrderDriverSummary[]>>(
			"/delivery-orders/summary",
			{ params: { ...withStatusList(filters), groupBy: "driver" } },
		);
		return response.data.data;
	},

	async getByInvoiceId(invoiceId: string): Promise<DeliveryOrderListItem> {
		const response = await apiClient.get<ApiResponse<DeliveryOrderListItem>>(
			`/invoices/${invoiceId}/delivery-orders`,
		);
		return response.data.data;
	},

	async createFromInvoice(
		invoiceId: string,
		payload?: { documentDate?: string; sourceWarehouseId?: string; notes?: string },
	): Promise<DeliveryOrderListItem> {
		const response = await apiClient.post<ApiResponse<DeliveryOrderListItem>>(
			`/invoices/${invoiceId}/delivery-orders`,
			payload ?? {},
		);
		return response.data.data;
	},

	async pick(
		id: string,
		items: Array<{ productId: string; condition: "GOOD"; quantity: number }>,
	): Promise<DeliveryOrderListItem> {
		const response = await apiClient.post<ApiResponse<DeliveryOrderListItem>>(
			`/delivery-orders/${id}/picking`,
			{ items },
		);
		return response.data.data;
	},

	async pack(
		id: string,
		items: Array<{ productId: string; condition: "GOOD"; quantity: number }>,
	): Promise<DeliveryOrderListItem> {
		const response = await apiClient.post<ApiResponse<DeliveryOrderListItem>>(
			`/delivery-orders/${id}/packing`,
			{ items },
		);
		return response.data.data;
	},

	async ship(
		id: string,
		payload: {
			shippedAt?: string;
			driverId: string;
			notes?: string;
			items: Array<{ productId: string; condition: "GOOD"; quantity: number }>;
		},
	): Promise<DeliveryOrderListItem> {
		const response = await apiClient.post<ApiResponse<DeliveryOrderListItem>>(
			`/delivery-orders/${id}/shipments`,
			payload,
		);
		return response.data.data;
	},

	// Canonical routes; the backend checks the delivery belongs to the calling
	// store, so a store session needs no separate path.
	async getByInvoiceIdForToko(invoiceId: string): Promise<DeliveryOrderListItem> {
		return this.getByInvoiceId(invoiceId);
	},

	// ponytail: seluruh halaman diambil seperti riwayat pesanan portal; pindah ke usePagedList di Fase 8 (BE #121).
	async listReplacementHistory(storeId?: string): Promise<DeliveryOrderListItem[]> {
		return collectPaginatedItems(async (page, limit) => {
			const response = await apiClient.get<PaginatedApiResponse<DeliveryOrderListItem>>(
				"/delivery-orders/replacement-history",
				{ params: { page, limit, ...(storeId ? { storeId } : {}) } },
			);
			return { items: response.data.data, meta: response.data.meta };
		});
	},

	async confirmReceiptForToko(
		id: string,
		payload?: { receivedAt?: string; receiptNotes?: string },
	): Promise<DeliveryOrderListItem> {
		const response = await apiClient.patch<ApiResponse<DeliveryOrderListItem>>(
			`/delivery-orders/${id}/receive`,
			payload ?? {},
		);
		return response.data.data;
	},
};
