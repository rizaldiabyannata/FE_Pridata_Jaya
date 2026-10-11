"use client";

export const dynamic = "force-dynamic";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CreateDeliveryOrderModal from "@/components/gudang/CreateDeliveryOrderModal";
import DeliveryOrderDetailModal from "@/components/gudang/DeliveryOrderDetailModal";
import { FeaturePage } from "@/components/shared/FeaturePage";
import PageFeedback from "@/components/shared/PageFeedback";
import PaginationControls from "@/components/shared/PaginationControls";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePagedList } from "@/hooks/usePagedList";
import { getApiErrorMessage } from "@/lib/api-errors";
import { logError } from "@/lib/log";
import { deliveryOrderStatusLabel, toUiLabel } from "@/lib/ui-labels";
import { driversService, type DriverListItem } from "@/services/drivers";
import {
	ACTIVE_DELIVERY_ORDER_STATUSES,
	deliveryOrdersService,
	rankSourceWarehouses,
	shippableStock,
	type DeliveryOrderDriverSummary,
	type DeliveryOrderListItem,
	type DeliveryOrderWarehouseSummary,
} from "@/services/delivery-orders";
import { invoicesService, type InvoiceListItem } from "@/services/invoices";
import {
	availabilityKey,
	indexAvailability,
	warehouseInventoryService,
	type StockAvailability,
} from "@/services/warehouse-inventory";
import { warehousesService, type WarehouseListItem } from "@/services/warehouses";

type WorkbenchTab = "create-do" | "driver" | "history";
type HistoryStatusFilter = "ALL" | "SHIPPED" | "RECEIVED";
type PagedListState = { items: unknown[]; loading: boolean; error: string; totalItems: number };

const PAGE_SIZE = 20;
const NO_STOCK = new Map<string, StockAvailability>();

const dateOnly = (value?: string | null) => (value ? String(value).slice(0, 10) : "-");
const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
const latestDriverName = (deliveryOrder: DeliveryOrderListItem) =>
	normalizeText(
		deliveryOrder.shipments.at(-1)?.driverNameSnapshot ??
			deliveryOrder.shipments.at(-1)?.driver?.name ??
			deliveryOrder.shipments.at(-1)?.driverName ??
			"",
	);
const getHistoryStatusMeta = (status: DeliveryOrderListItem["status"]) => {
	if (status === "RECEIVED") {
		return {
			label: "Berhasil diterima",
			className: "border border-emerald-200 bg-emerald-50/80 text-emerald-700",
		};
	}
	return {
		label: "Sedang dikirim",
		className: "border border-sky-200 bg-sky-50/80 text-sky-700",
	};
};
/** Jumlah dari `meta.totalItems`; "—" selama belum ada data yang bisa dipercaya. */
const countOf = (list: PagedListState) =>
	list.items.length === 0 && (list.loading || list.error) ? "—" : list.totalItems;

const buildShipmentItems = (deliveryOrder: DeliveryOrderListItem) =>
	deliveryOrder.items
		.map((item) => ({
			productId: item.productId,
			condition: item.condition,
			quantity: item.orderedQuantity - item.shippedQuantity,
		}))
		.filter(
			(item): item is { productId: string; condition: "GOOD"; quantity: number } =>
				item.quantity > 0 && item.condition === "GOOD",
		);

function PengirimanPageContent() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const focusInvoiceId = searchParams.get("invoiceId");

	const [actionError, setActionError] = useState("");
	const [success, setSuccess] = useState("");
	const [search, setSearch] = useState("");
	const debouncedSearch = useDebouncedValue(search.trim());
	const [warehouseFilter, setWarehouseFilter] = useState("ALL");
	const [driverWarehouseFilter, setDriverWarehouseFilter] = useState("ALL");
	const [activeTab, setActiveTab] = useState<WorkbenchTab>("create-do");
	const [historyStatusFilter, setHistoryStatusFilter] = useState<HistoryStatusFilter>("ALL");
	const [actionId, setActionId] = useState<string | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [driverSelections, setDriverSelections] = useState<Record<string, string>>({});
	const [sourceWarehouseSelections, setSourceWarehouseSelections] = useState<Record<string, string>>({});
	const [createTarget, setCreateTarget] = useState<InvoiceListItem | null>(null);
	const [selectedDeliveryOrder, setSelectedDeliveryOrder] =
		useState<DeliveryOrderListItem | null>(null);

	const searchParam = debouncedSearch || undefined;
	const warehouseParam = warehouseFilter === "ALL" ? undefined : warehouseFilter;

	// Master data kecil (dropdown): boleh diambil utuh.
	const [warehouses, setWarehouses] = useState<WarehouseListItem[]>([]);
	const [drivers, setDrivers] = useState<DriverListItem[]>([]);
	const [masterError, setMasterError] = useState("");
	const [masterTick, setMasterTick] = useState(0);
	useEffect(() => {
		let active = true;
		Promise.all([
			warehousesService.listAll(),
			driversService.listAll({ isActive: true, sortBy: "name", sortOrder: "asc" }),
		])
			.then(([warehouseItems, driverItems]) => {
				if (!active) return;
				setWarehouses(warehouseItems);
				setDrivers(driverItems);
				setMasterError("");
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setMasterError(getApiErrorMessage(cause, "Gagal memuat daftar gudang dan driver."));
				logError("Gagal memuat daftar gudang dan driver.", cause);
			});
		return () => { active = false; };
	}, [masterTick]);

	// Kartu headline, audit per gudang/driver, dan jumlah per gudang di tab Isi Driver: semuanya dari server.
	const [summary, setSummary] = useState<{
		byWarehouse: DeliveryOrderWarehouseSummary[];
		byDriver: DeliveryOrderDriverSummary[];
	} | null>(null);
	const [summaryError, setSummaryError] = useState("");
	const [summaryTick, setSummaryTick] = useState(0);
	useEffect(() => {
		let active = true;
		const filters = {
			search: debouncedSearch || undefined,
			sourceWarehouseId: warehouseFilter === "ALL" ? undefined : warehouseFilter,
		};
		Promise.all([
			deliveryOrdersService.summaryByWarehouse(filters),
			deliveryOrdersService.summaryByDriver(filters),
		])
			.then(([byWarehouse, byDriver]) => {
				if (!active) return;
				setSummary({ byWarehouse, byDriver });
				setSummaryError("");
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setSummary(null); // tampil "—", bukan 0
				setSummaryError(getApiErrorMessage(cause, "Gagal memuat ringkasan pengiriman."));
				logError("Gagal memuat ringkasan pengiriman.", cause);
			});
		return () => { active = false; };
	}, [debouncedSearch, warehouseFilter, summaryTick]);

	const totals = useMemo(
		() =>
			summary?.byWarehouse.reduce(
				(sum, row) => ({
					activeDo: sum.activeDo + row.activeDo,
					shippedDo: sum.shippedDo + row.shippedDo,
					totalDo: sum.totalDo + row.totalDo,
				}),
				{ activeDo: 0, shippedDo: 0, totalDo: 0 },
			) ?? null,
		[summary],
	);

	const driverWarehouseOptions = useMemo(
		() => (summary?.byWarehouse ?? []).filter((row) => row.activeDo > 0),
		[summary],
	);
	// Pilihan gudang yang tidak punya DO aktif lagi (mis. setelah filter berubah) kembali ke "Semua".
	const effectiveDriverWarehouseFilter =
		driverWarehouseFilter === "ALL" ||
		!summary ||
		driverWarehouseOptions.some((row) => row.warehouseId === driverWarehouseFilter)
			? driverWarehouseFilter
			: "ALL";
	const driverWarehouseParam =
		effectiveDriverWarehouseFilter === "ALL" ? warehouseParam : effectiveDriverWarehouseFilter;

	const createList = usePagedList(
		(page, limit) =>
			invoicesService.listDeliveryQueue({ page, limit, search: searchParam, sourceWarehouseId: warehouseParam }),
		{
			filterKey: `${debouncedSearch}|${warehouseFilter}`,
			errorMessage: "Gagal memuat invoice siap DO.",
			pageSize: PAGE_SIZE,
		},
	);
	const driverList = usePagedList(
		(page, limit) =>
			deliveryOrdersService.list({
				page,
				limit,
				sortBy: "documentDate",
				sortOrder: "desc",
				status: ACTIVE_DELIVERY_ORDER_STATUSES,
				search: searchParam,
				sourceWarehouseId: driverWarehouseParam,
			}),
		{
			filterKey: `${debouncedSearch}|${driverWarehouseParam ?? "ALL"}`,
			errorMessage: "Gagal memuat DO aktif.",
			pageSize: PAGE_SIZE,
		},
	);
	const historyList = usePagedList(
		(page, limit) =>
			deliveryOrdersService.list({
				page,
				limit,
				sortBy: "documentDate",
				sortOrder: "desc",
				status: historyStatusFilter === "ALL" ? ["SHIPPED", "RECEIVED"] : historyStatusFilter,
				search: searchParam,
				sourceWarehouseId: warehouseParam,
			}),
		{
			filterKey: `${debouncedSearch}|${warehouseFilter}|${historyStatusFilter}`,
			errorMessage: "Gagal memuat riwayat pengiriman.",
			pageSize: PAGE_SIZE,
		},
	);

	// Deep link `?invoiceId=` (dari fakturis): invoice dan DO-nya diambil langsung, walau tidak ada di halaman ini.
	const [focus, setFocus] = useState<{
		invoiceId: string;
		invoice: InvoiceListItem | null;
		deliveryOrder: DeliveryOrderListItem | null;
	} | null>(null);
	const [focusFailure, setFocusFailure] = useState<{ invoiceId: string; message: string } | null>(null);
	const [focusTick, setFocusTick] = useState(0);
	useEffect(() => {
		if (!focusInvoiceId) return;
		let active = true;
		Promise.all([
			invoicesService.getById(focusInvoiceId),
			deliveryOrdersService.list({ invoiceId: focusInvoiceId, page: 1, limit: 1 }),
		])
			.then(([invoice, { items }]) => {
				if (!active) return;
				setFocusFailure(null);
				// Invoice batal tidak masuk meja kerja gudang, sama seperti sebelumnya.
				const eligible = invoice.status !== "CANCELLED";
				setFocus({
					invoiceId: focusInvoiceId,
					invoice: eligible ? invoice : null,
					deliveryOrder: eligible ? items[0] ?? null : null,
				});
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setFocusFailure({
					invoiceId: focusInvoiceId,
					message: getApiErrorMessage(cause, "Gagal membuka invoice yang dituju."),
				});
				logError("Gagal membuka invoice yang dituju.", cause);
			});
		return () => { active = false; };
	}, [focusInvoiceId, focusTick]);
	const focusedInvoice = focus && focus.invoiceId === focusInvoiceId ? focus.invoice : null;
	const focusedDeliveryOrder = focus && focus.invoiceId === focusInvoiceId ? focus.deliveryOrder : null;
	const focusError = focusFailure && focusFailure.invoiceId === focusInvoiceId ? focusFailure.message : "";

	const activeCreateInvoice = createTarget ?? (focusedInvoice && !focusedDeliveryOrder ? focusedInvoice : null);
	const detailDeliveryOrder = selectedDeliveryOrder ?? focusedDeliveryOrder;

	// Ketersediaan stok (aturan server, R21) hanya untuk produk yang sedang tampil atau sedang diproses.
	const stockProductKey = useMemo(() => {
		const ids = new Set<string>();
		for (const invoice of [...createList.items, activeCreateInvoice]) {
			for (const item of invoice?.order?.items ?? []) ids.add(item.productId);
		}
		for (const deliveryOrder of [...driverList.items, detailDeliveryOrder]) {
			for (const item of deliveryOrder?.items ?? []) ids.add(item.productId);
		}
		return [...ids].sort().join(",");
	}, [activeCreateInvoice, createList.items, detailDeliveryOrder, driverList.items]);
	const [stock, setStock] = useState<{ key: string; rows: Map<string, StockAvailability> } | null>(null);
	const [stockError, setStockError] = useState("");
	const [stockTick, setStockTick] = useState(0);
	useEffect(() => {
		if (!stockProductKey) return;
		let active = true;
		warehouseInventoryService
			.availability(stockProductKey.split(","), undefined, "GOOD")
			.then((rows) => {
				if (!active) return;
				setStock({ key: stockProductKey, rows: indexAvailability(rows) });
				setStockError("");
			})
			.catch((cause: unknown) => {
				if (!active) return;
				setStockError(getApiErrorMessage(cause, "Gagal memeriksa ketersediaan stok."));
				logError("Gagal memeriksa ketersediaan stok.", cause);
			});
		return () => { active = false; };
	}, [stockProductKey, stockTick]);
	const stockReady = !stockProductKey || stock?.key === stockProductKey;
	const stockRows = stock?.rows ?? NO_STOCK;
	const saleStock = (warehouseId: string, productId: string) =>
		stockRows.get(availabilityKey(warehouseId, productId))?.available ?? 0;

	const sourceWarehousesByInvoiceId = useMemo(() => {
		const result: Record<string, ReturnType<typeof rankSourceWarehouses>> = {};
		for (const invoice of [...createList.items, activeCreateInvoice]) {
			if (invoice) result[invoice.id] = rankSourceWarehouses(invoice.order?.items ?? [], warehouses, stockRows);
		}
		return result;
	}, [activeCreateInvoice, createList.items, stockRows, warehouses]);

	const getSelectedSourceWarehouseId = (invoice: InvoiceListItem | null) => {
		if (!invoice) return "";
		const options = sourceWarehousesByInvoiceId[invoice.id] ?? [];
		const selectedId = sourceWarehouseSelections[invoice.id];
		if (selectedId && options.some((item) => item.id === selectedId)) {
			return selectedId;
		}
		const preferredId = invoice.order?.sourceWarehouseId;
		if (preferredId && options.some((item) => item.id === preferredId)) {
			return preferredId;
		}
		return options[0]?.id ?? "";
	};

	const focusInfoMessage = !focusedInvoice
		? ""
		: focusedDeliveryOrder
			? `Invoice ${focusedInvoice.invoiceNumber} sudah punya delivery order ${focusedDeliveryOrder.deliveryOrderNumber}. Dokumen dibuka untuk dilanjutkan oleh gudang.`
			: `Invoice ${focusedInvoice.invoiceNumber} baru difinalisasi fakturis dan siap diturunkan menjadi delivery order.`;

	const driverIdOf = (deliveryOrder: DeliveryOrderListItem) =>
		driverSelections[deliveryOrder.id] ?? deliveryOrder.shipments.at(-1)?.driverId ?? "";

	const tabItems: Array<{ id: WorkbenchTab; label: string; count: number | string }> = [
		{ id: "create-do", label: "Buat DO", count: countOf(createList) },
		{ id: "driver", label: "Isi Driver", count: countOf(driverList) },
		{ id: "history", label: "Riwayat", count: countOf(historyList) },
	];

	const getShipmentShortages = (deliveryOrder: DeliveryOrderListItem) =>
		buildShipmentItems(deliveryOrder)
			.map((item) => ({
				productId: item.productId,
				productName:
					deliveryOrder.items.find(
						(row) => row.productId === item.productId && row.condition === item.condition,
					)?.product?.name ?? "Produk",
				condition: item.condition,
				required: item.quantity,
				available: shippableStock(
					deliveryOrder,
					item.productId,
					stockRows.get(availabilityKey(deliveryOrder.sourceWarehouseId, item.productId)),
				),
			}))
			.filter((item) => item.available < item.required);

	const getShipmentBlockedReason = (deliveryOrder: DeliveryOrderListItem | null) => {
		if (!deliveryOrder) return "";
		const shipmentItems = buildShipmentItems(deliveryOrder);
		if (shipmentItems.length === 0) {
			return "Tidak ada sisa barang yang perlu dikirim untuk delivery order ini.";
		}
		if (!driverIdOf(deliveryOrder)) {
			return "Driver wajib dipilih sebelum tombol kirim bisa digunakan.";
		}
		if (!stockReady) {
			return stockError ? stockFailedMessage : "Memeriksa ketersediaan stok gudang...";
		}
		const shortages = getShipmentShortages(deliveryOrder);
		if (shortages.length > 0) {
			const firstShortage = shortages[0];
			return `Stok ${firstShortage.productName} di ${
				warehouses.find((warehouse) => warehouse.id === deliveryOrder.sourceWarehouseId)?.name ??
				"gudang pengirim"
			} tidak mencukupi. Tersedia ${firstShortage.available}, dibutuhkan ${firstShortage.required}.`;
		}
		if (
			deliveryOrder.status === "SHIPPED" ||
			deliveryOrder.status === "CANCELLED" ||
			deliveryOrder.status === "RECEIVED"
		) {
			return "Delivery order ini sudah tidak bisa diproses kirim lagi.";
		}
		return "";
	};

	const reloadAll = () => {
		createList.reload();
		driverList.reload();
		historyList.reload();
		setSummaryTick((tick) => tick + 1);
		setStockTick((tick) => tick + 1);
	};

	const loadError =
		createList.error ||
		driverList.error ||
		historyList.error ||
		summaryError ||
		stockError ||
		masterError ||
		focusError;
	const retryLoad = () => {
		if (createList.error) createList.reload();
		if (driverList.error) driverList.reload();
		if (historyList.error) historyList.reload();
		if (summaryError) setSummaryTick((tick) => tick + 1);
		if (stockError) setStockTick((tick) => tick + 1);
		if (masterError) setMasterTick((tick) => tick + 1);
		if (focusError) setFocusTick((tick) => tick + 1);
	};
	const stockFailedMessage = "Stok gudang gagal dimuat. Tekan \"Coba lagi\" pada pesan galat.";

	const clearFocusedInvoice = () => {
		if (!focusInvoiceId) return;
		router.replace("/gudang/pengiriman");
	};

	const handleCreateDeliveryOrder = async (invoice: InvoiceListItem) => {
		const sourceWarehouseId = getSelectedSourceWarehouseId(invoice);
		if (!sourceWarehouseId) {
			setActionError("Pilih gudang pengirim terlebih dahulu.");
			return;
		}
		if (!stockReady) {
			setActionError(stockError ? stockFailedMessage : "Ketersediaan stok masih diperiksa. Coba lagi sebentar.");
			return;
		}
		const orderItems = invoice.order?.items ?? [];
		const shortages = orderItems.filter((item) =>
			item.condition !== "GOOD" || saleStock(sourceWarehouseId, item.productId) < item.quantity,
		);
		if (shortages.length > 0) {
			setActionError("Stok gudang pengirim belum cukup. Periksa kekurangan item di detail pesanan lalu lakukan transfer gudang bila diperlukan.");
			return;
		}

		setActionId(invoice.id);
		setActionError("");
		setSuccess("");
		try {
			await deliveryOrdersService.createFromInvoice(invoice.id, {
				sourceWarehouseId,
				notes:
					[
						`Gudang pengirim: ${
							warehouses.find((warehouse) => warehouse.id === sourceWarehouseId)?.name ?? "-"
						}`,
						notes[invoice.id]?.trim() || "",
					]
						.filter(Boolean)
						.join("\n") || undefined,
			});
			setCreateTarget(null);
			setActiveTab("driver");
			clearFocusedInvoice();
			setSuccess(`Delivery order dari invoice ${invoice.invoiceNumber} berhasil dibuat.`);
			reloadAll();
		} catch (error: unknown) {
			setActionError(getApiErrorMessage(error, "Gagal membuat delivery order dari invoice."));
		} finally {
			setActionId(null);
		}
	};

	const handleProcessDeliveryOrder = async (deliveryOrder: DeliveryOrderListItem) => {
		const shipmentBlockedReason = getShipmentBlockedReason(deliveryOrder);
		const items = buildShipmentItems(deliveryOrder);

		setActionId(deliveryOrder.id);
		setActionError("");
		setSuccess("");
		try {
			if (shipmentBlockedReason) {
				setActionError(shipmentBlockedReason);
				return;
			}
			if (items.length === 0) return;
			await deliveryOrdersService.ship(deliveryOrder.id, {
				driverId: driverIdOf(deliveryOrder),
				notes: notes[deliveryOrder.id]?.trim() || undefined,
				items,
			});
			setSuccess(`${deliveryOrder.deliveryOrderNumber} berhasil dikirim.`);
			setSelectedDeliveryOrder(null);
			setActiveTab("history");
			clearFocusedInvoice();
			reloadAll();
		} catch (error: unknown) {
			setActionError(getApiErrorMessage(error, "Gagal menjalankan pengiriman."));
		} finally {
			setActionId(null);
		}
	};

	const activeCreateOrderItems = activeCreateInvoice?.order?.items ?? [];
	const activeCreateSourceWarehouseId = getSelectedSourceWarehouseId(activeCreateInvoice);
	const activeCreateStockRows = activeCreateOrderItems.map((item) => {
		const available =
			activeCreateSourceWarehouseId && item.condition === "GOOD"
				? saleStock(activeCreateSourceWarehouseId, item.productId)
				: 0;

		return {
			orderItemId: item.id,
			available,
			required: item.quantity,
			fulfilled: available >= item.quantity,
		};
	});

	return (
		<FeaturePage
			title="Pengiriman"
				description="Meja kerja gudang untuk menerima invoice final dari fakturis, memeriksa ketersediaan stok, lalu memproses pengiriman."
		>
			<PageFeedback
				error={actionError || loadError}
				success={success}
				// Galat muat tidak bisa ditutup: tanpa pesan itu tabel/stok tampak kosong atau "memuat" selamanya.
				onDismissError={actionError ? () => setActionError("") : undefined}
				onDismissSuccess={() => setSuccess("")}
				onRetry={actionError ? undefined : retryLoad}
			/>
			<section className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
				Nama driver wajib diisi sebelum kirim. Gudang pengirim yang dipilih akan menjadi sumber pengurangan stok, sehingga pergerakan barang antar gudang tetap jelas dan transparan.
			</section>

			<section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				{[
					{ label: "Invoice Siap DO", value: countOf(createList) },
					{ label: "DO Aktif", value: totals?.activeDo ?? "—" },
					{ label: "DO Terkirim", value: totals?.shippedDo ?? "—" },
					{ label: "Total DO", value: totals?.totalDo ?? "—" },
				].map((item) => (
					<div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
						<p className="text-xs uppercase tracking-[0.18em] text-slate-500">{item.label}</p>
						<p className="mt-3 text-3xl font-semibold text-slate-900">{item.value}</p>
					</div>
				))}
			</section>

			{focusInvoiceId ? (
				<div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
					Halaman ini dibuka dari riwayat transaksi fakturis untuk melanjutkan invoice ke gudang.
				</div>
			) : null}

			<section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
				<div className="mb-4 flex flex-wrap gap-2">
					{tabItems.map((tab) => {
						const active = activeTab === tab.id;
						return (
							<button
								key={tab.id}
								type="button"
								onClick={() => setActiveTab(tab.id)}
								className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
									active
										? "border-indigo-600 bg-indigo-600 text-white"
										: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
								}`}
							>
								{tab.label} <span className={active ? "text-slate-200" : "text-slate-500"}>{tab.count}</span>
							</button>
						);
					})}
				</div>
				<div className="flex flex-col gap-3 md:flex-row">
					<input
						className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
						placeholder="Cari invoice, DO, order, toko, atau driver"
						maxLength={100}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<select
						value={warehouseFilter}
						onChange={(event) => {
							setWarehouseFilter(event.target.value);
							setDriverWarehouseFilter("ALL");
						}}
						className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
					>
						<option value="ALL">Semua Gudang</option>
						{warehouses.map((warehouse) => (
							<option key={warehouse.id} value={warehouse.id}>
								{warehouse.name}
							</option>
						))}
					</select>
				</div>
			</section>

			<section className="grid gap-4 xl:grid-cols-2">
				<div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
					<div className="border-b border-slate-200 px-4 py-3">
						<h2 className="text-lg font-semibold text-slate-900">Audit Per Gudang</h2>
						<p className="mt-1 text-sm text-slate-500">
							Ringkasan ini membantu melihat DO aktif dan barang terkirim dari masing-masing gudang sumber.
						</p>
					</div>
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-3">Gudang</th>
								<th className="px-4 py-3 text-right">DO Aktif</th>
								<th className="px-4 py-3 text-right">DO Terkirim</th>
								<th className="px-4 py-3 text-right">Qty Terkirim</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{!summary || summary.byWarehouse.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={4}>
										{summary
											? "Belum ada data pengiriman untuk filter yang dipilih."
											: summaryError
												? "Ringkasan belum bisa dimuat."
												: "Memuat ringkasan pengiriman..."}
									</td>
								</tr>
							) : (
								summary.byWarehouse.map((item) => (
									<tr key={item.warehouseId}>
										<td className="px-4 py-3 text-slate-900">
											<div className="font-medium">{item.warehouseName}</div>
											<div className="text-xs text-slate-500">{item.totalDo} total DO</div>
										</td>
										<td className="px-4 py-3 text-right text-slate-700">{item.activeDo}</td>
										<td className="px-4 py-3 text-right text-slate-700">{item.shippedDo}</td>
										<td className="px-4 py-3 text-right text-slate-900">{item.totalItemsShipped}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>

				<div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
					<div className="border-b border-slate-200 px-4 py-3">
						<h2 className="text-lg font-semibold text-slate-900">Audit Per Driver</h2>
						<p className="mt-1 text-sm text-slate-500">
							Driver hanya muncul di area gudang agar tim bisa audit pengiriman tanpa masuk ke meja kerja fakturis.
						</p>
					</div>
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-3">Driver</th>
								<th className="px-4 py-3 text-right">Shipment</th>
								<th className="px-4 py-3 text-right">DO</th>
								<th className="px-4 py-3">Terakhir Kirim</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{!summary || summary.byDriver.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={4}>
										{summary
											? "Belum ada driver yang tercatat untuk filter yang dipilih."
											: summaryError
												? "Ringkasan belum bisa dimuat."
												: "Memuat ringkasan pengiriman..."}
									</td>
								</tr>
							) : (
								summary.byDriver.map((item) => (
									<tr key={item.driverName}>
										<td className="px-4 py-3 font-medium text-slate-900">{item.driverName}</td>
										<td className="px-4 py-3 text-right text-slate-700">{item.totalShipments}</td>
										<td className="px-4 py-3 text-right text-slate-700">{item.totalDo}</td>
										<td className="px-4 py-3 text-slate-700">{dateOnly(item.lastShippedAt)}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</section>

			{!success && focusInfoMessage ? (
				<div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
					{focusInfoMessage}
				</div>
			) : null}

			{activeTab === "create-do" ? (
				<section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
					<div className="border-b border-slate-200 px-4 py-3">
						<h2 className="text-lg font-semibold text-slate-900">Buat Delivery Order</h2>
						<p className="mt-1 text-sm text-slate-500">
							Buka detail pesanan untuk memeriksa stok tiap item. Jika kurang, lakukan transfer gudang sebelum membuat DO.
						</p>
					</div>
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-3">Invoice</th>
								<th className="px-4 py-3">Toko</th>
								<th className="px-4 py-3">Gudang Siap</th>
								<th className="px-4 py-3">Barang</th>
								<th className="px-4 py-3 text-right">Aksi</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{createList.loading && createList.items.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={5}>
										Memuat invoice siap DO...
									</td>
								</tr>
							) : createList.items.length === 0 ? (
								createList.error ? null : (
									<tr>
										<td className="px-4 py-4 text-slate-600" colSpan={5}>
											Tidak ada invoice final yang perlu dibuatkan DO untuk filter ini.
										</td>
									</tr>
								)
							) : (
								createList.items.map((invoice) => {
									const options = sourceWarehousesByInvoiceId[invoice.id] ?? [];
									const selectedWarehouseId = getSelectedSourceWarehouseId(invoice);
									const selectedWarehouse = options.find((warehouse) => warehouse.id === selectedWarehouseId);
									const disabled = actionId === invoice.id;
									const isFocused = focusInvoiceId === invoice.id;
									const orderItems = invoice.order?.items ?? [];
									const totalQuantity = orderItems.reduce((sum, item) => sum + item.quantity, 0);

									return (
										<tr key={invoice.id} className={isFocused ? "bg-indigo-50" : undefined}>
											<td className="px-4 py-3 align-top">
												<div className="font-medium text-slate-900">{invoice.invoiceNumber}</div>
												<div className="text-xs text-slate-500">
													{invoice.order?.orderNumber ?? "-"} | {dateOnly(invoice.invoiceDate)}
												</div>
											</td>
											<td className="px-4 py-3 align-top text-slate-700">
												<div>{invoice.storeNameSnapshot}</div>
												<div className="text-xs text-slate-500">{invoice.status}</div>
											</td>
											<td className="px-4 py-3 align-top text-slate-700">
											<div>{selectedWarehouse?.name ?? "Pilih gudang di detail"}</div>
												<div className="text-xs text-slate-500">
												{!stockReady ? (stockError ? "Stok gagal dimuat" : "Memeriksa stok...") : options.length > 0 ? `${options.filter((item) => item.shortfallCount === 0).length} gudang stok cukup` : "Belum ada gudang tersedia"}
												</div>
											</td>
											<td className="px-4 py-3 align-top text-slate-700">
												<div className="font-medium text-slate-900">{orderItems.length} jenis</div>
												<div className="text-xs text-slate-500">{totalQuantity} total qty</div>
											</td>
											<td className="px-4 py-3 text-right align-top">
												<button
													type="button"
													onClick={() => setCreateTarget(invoice)}
													disabled={disabled}
													className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-60"
												>
													{actionId === invoice.id ? "Membuat..." : "Buat DO"}
												</button>
											</td>
										</tr>
									);
								})
							)}
						</tbody>
					</table>
					<PaginationControls
						currentPage={createList.page}
						totalPages={createList.totalPages}
						totalItems={createList.totalItems}
						currentItemCount={createList.items.length}
						pageSize={PAGE_SIZE}
						itemLabel="invoice"
						loading={createList.loading}
						onPageChange={createList.setPage}
					/>
				</section>
			) : null}

			{activeTab === "driver" ? (
				<section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
					<div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
						<div>
							<h2 className="text-lg font-semibold text-slate-900">Isi Driver</h2>
							<p className="mt-1 text-sm text-slate-500">
								DO yang sudah dibuat masuk ke tahap ini. Driver wajib diisi sebelum DO diproses sebagai pengiriman.
							</p>
						</div>
						<div className="w-full lg:w-72">
							<label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
								Filter Gudang
							</label>
							<select
								value={effectiveDriverWarehouseFilter}
								onChange={(event) => setDriverWarehouseFilter(event.target.value)}
								className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
							>
								<option value="ALL">Semua Gudang ({totals?.activeDo ?? "—"})</option>
								{driverWarehouseOptions.map((warehouse) => (
									<option key={warehouse.warehouseId} value={warehouse.warehouseId}>
										{warehouse.warehouseName} ({warehouse.activeDo})
									</option>
								))}
							</select>
						</div>
					</div>
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-3">Delivery Order</th>
								<th className="px-4 py-3">Toko</th>
								<th className="px-4 py-3">Gudang</th>
								<th className="px-4 py-3">Driver</th>
								<th className="px-4 py-3 text-right">Aksi</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{driverList.loading && driverList.items.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={5}>
										Memuat DO aktif...
									</td>
								</tr>
							) : driverList.items.length === 0 ? (
								driverList.error ? null : (
									<tr>
										<td className="px-4 py-4 text-slate-600" colSpan={5}>
											Tidak ada DO yang menunggu driver untuk filter ini.
										</td>
									</tr>
								)
							) : (
								driverList.items.map((deliveryOrder) => {
									const orderedTotal = deliveryOrder.items.reduce((sum, item) => sum + item.orderedQuantity, 0);
									const shippedTotal = deliveryOrder.items.reduce((sum, item) => sum + item.shippedQuantity, 0);
									const blockedReason = getShipmentBlockedReason(deliveryOrder);
									const driverId = driverIdOf(deliveryOrder);
									const warehouseName =
										warehouses.find((warehouse) => warehouse.id === deliveryOrder.sourceWarehouseId)?.name ??
										deliveryOrder.sourceWarehouseId;

									return (
										<tr key={deliveryOrder.id}>
											<td className="px-4 py-3 align-top">
												<div className="font-medium text-slate-900">{deliveryOrder.deliveryOrderNumber}</div>
												<div className="text-xs text-slate-500">
													{toUiLabel(deliveryOrder.status, deliveryOrderStatusLabel)} | {dateOnly(deliveryOrder.documentDate)}
												</div>
												<div className="text-xs text-slate-500">
													Terkirim {shippedTotal}/{orderedTotal}
												</div>
											</td>
											<td className="px-4 py-3 align-top text-slate-700">{deliveryOrder.storeNameSnapshot}</td>
											<td className="px-4 py-3 align-top text-slate-700">{warehouseName}</td>
											<td className="px-4 py-3 align-top">
												<select
													className="w-full min-w-52 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
													value={driverId}
													onChange={(event) =>
														setDriverSelections((prev) => ({
															...prev,
															[deliveryOrder.id]: event.target.value,
														}))
													}
												>
													<option value="">Pilih driver</option>
													{drivers.map((driver) => (
														<option key={driver.id} value={driver.id}>
															{driver.name}
														</option>
													))}
												</select>
												{blockedReason ? (
													<div className="mt-1 text-xs text-amber-700">{blockedReason}</div>
												) : (
													<div className="mt-1 text-xs text-emerald-700">Driver terpilih, DO siap dikirim.</div>
												)}
											</td>
											<td className="px-4 py-3 text-right align-top">
												<div className="flex justify-end gap-2">
													<button
														type="button"
														onClick={() => setSelectedDeliveryOrder(deliveryOrder)}
														className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
													>
														Detail
													</button>
													<button
														type="button"
														onClick={() => void handleProcessDeliveryOrder(deliveryOrder)}
														disabled={Boolean(blockedReason) || actionId === deliveryOrder.id}
														className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-60"
													>
														{actionId === deliveryOrder.id ? "Mengirim..." : "Kirim"}
													</button>
												</div>
											</td>
										</tr>
									);
								})
							)}
						</tbody>
					</table>
					<PaginationControls
						currentPage={driverList.page}
						totalPages={driverList.totalPages}
						totalItems={driverList.totalItems}
						currentItemCount={driverList.items.length}
						pageSize={PAGE_SIZE}
						itemLabel="DO"
						loading={driverList.loading}
						onPageChange={driverList.setPage}
					/>
				</section>
			) : null}

			{activeTab === "history" ? (
				<section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
					<div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
						<div>
							<h2 className="text-lg font-semibold text-slate-900">Riwayat Pengiriman</h2>
							<p className="mt-1 text-sm text-slate-500">
								DO yang sudah diproses kirim dan DO yang sudah diterima toko ditampilkan sebagai riwayat operasional gudang.
							</p>
						</div>
						<select
							value={historyStatusFilter}
							onChange={(event) => setHistoryStatusFilter(event.target.value as HistoryStatusFilter)}
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 md:w-52"
						>
							<option value="ALL">Semua Status</option>
							<option value="SHIPPED">Sedang Dikirim</option>
							<option value="RECEIVED">Berhasil Diterima</option>
						</select>
					</div>
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th className="px-4 py-3">Delivery Order</th>
								<th className="px-4 py-3">Toko</th>
								<th className="px-4 py-3">Driver</th>
								<th className="px-4 py-3">Status</th>
								<th className="px-4 py-3 text-right">Aksi</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{historyList.loading && historyList.items.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={5}>
										Memuat riwayat pengiriman...
									</td>
								</tr>
							) : historyList.items.length === 0 ? (
								historyList.error ? null : (
									<tr>
										<td className="px-4 py-4 text-slate-600" colSpan={5}>
											Belum ada DO terkirim atau diterima untuk filter ini.
										</td>
									</tr>
								)
							) : (
								historyList.items.map((deliveryOrder) => {
									const orderedTotal = deliveryOrder.items.reduce((sum, item) => sum + item.orderedQuantity, 0);
									const shippedTotal = deliveryOrder.items.reduce((sum, item) => sum + item.shippedQuantity, 0);
									const driverName = latestDriverName(deliveryOrder) || "-";
									const statusMeta = getHistoryStatusMeta(deliveryOrder.status);

									return (
										<tr key={deliveryOrder.id}>
											<td className="px-4 py-3 align-top">
												<div className="font-medium text-slate-900">{deliveryOrder.deliveryOrderNumber}</div>
												<div className="text-xs text-slate-500">{dateOnly(deliveryOrder.documentDate)}</div>
												<div className="text-xs text-slate-500">Terkirim {shippedTotal}/{orderedTotal}</div>
											</td>
											<td className="px-4 py-3 align-top text-slate-700">{deliveryOrder.storeNameSnapshot}</td>
											<td className="px-4 py-3 align-top text-slate-700">{driverName}</td>
											<td className="px-4 py-3 align-top">
												<span
													className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold shadow-sm backdrop-blur ${statusMeta.className}`}
												>
													{statusMeta.label}
												</span>
											</td>
											<td className="px-4 py-3 text-right align-top">
												<button
													type="button"
													onClick={() => setSelectedDeliveryOrder(deliveryOrder)}
													className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
												>
													Detail
												</button>
											</td>
										</tr>
									);
								})
							)}
						</tbody>
					</table>
					<PaginationControls
						currentPage={historyList.page}
						totalPages={historyList.totalPages}
						totalItems={historyList.totalItems}
						currentItemCount={historyList.items.length}
						pageSize={PAGE_SIZE}
						itemLabel="DO"
						loading={historyList.loading}
						onPageChange={historyList.setPage}
					/>
				</section>
			) : null}

			<CreateDeliveryOrderModal
				invoice={activeCreateInvoice}
				orderItems={activeCreateOrderItems}
				itemStockRows={activeCreateStockRows}
				sourceWarehouseId={activeCreateSourceWarehouseId}
				sourceWarehouseOptions={activeCreateInvoice ? sourceWarehousesByInvoiceId[activeCreateInvoice.id] ?? [] : []}
				notes={activeCreateInvoice ? notes[activeCreateInvoice.id] ?? "" : ""}
				submitting={Boolean(actionId)}
				onSourceWarehouseChange={(value) => {
					if (!activeCreateInvoice) return;
					setSourceWarehouseSelections((prev) => ({ ...prev, [activeCreateInvoice.id]: value }));
				}}
				onNotesChange={(value) => {
					if (!activeCreateInvoice) return;
					setNotes((prev) => ({ ...prev, [activeCreateInvoice.id]: value }));
				}}
				onClose={() => {
					setCreateTarget(null);
					clearFocusedInvoice();
				}}
				onConfirm={handleCreateDeliveryOrder}
			/>

			<DeliveryOrderDetailModal
				deliveryOrder={detailDeliveryOrder}
				shippingWarehouseName={
					warehouses.find((warehouse) => warehouse.id === detailDeliveryOrder?.sourceWarehouseId)?.name ?? ""
				}
				driverId={detailDeliveryOrder ? driverIdOf(detailDeliveryOrder) : ""}
				drivers={drivers}
				notes={detailDeliveryOrder ? notes[detailDeliveryOrder.id] ?? "" : ""}
				submitting={Boolean(actionId)}
				shipmentItems={detailDeliveryOrder ? buildShipmentItems(detailDeliveryOrder) : []}
				shipmentBlockedReason={getShipmentBlockedReason(detailDeliveryOrder)}
				onNotesChange={(value) => {
					if (!detailDeliveryOrder) return;
					setNotes((prev) => ({ ...prev, [detailDeliveryOrder.id]: value }));
				}}
				onDriverIdChange={(value) => {
					if (!detailDeliveryOrder) return;
					setDriverSelections((prev) => ({ ...prev, [detailDeliveryOrder.id]: value }));
				}}
				onClose={() => {
					setSelectedDeliveryOrder(null);
					clearFocusedInvoice();
				}}
				onProcess={handleProcessDeliveryOrder}
			/>
		</FeaturePage>
	);
}

export default function PengirimanPage() {
	return (
		<Suspense fallback={<FeaturePage title="Pengiriman" description="Memuat meja kerja gudang..." />}>
			<PengirimanPageContent />
		</Suspense>
	);
}
