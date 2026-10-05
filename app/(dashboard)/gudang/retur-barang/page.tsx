"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "@/components/shared/Modal";
import { FeaturePage } from "@/components/shared/FeaturePage";
import PageFeedback from "@/components/shared/PageFeedback";
import PaginationControls from "@/components/shared/PaginationControls";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatAppDateTime } from "@/lib/datetime";
import { formatRupiah } from "@/lib/format";
import { returnLifecycleLabel } from "@/lib/ui-labels";
import {
	storeReturnsService,
	type ReturnLifecycleStatus,
	type StoreReturnItemCondition,
	type StoreReturnRequestItem,
} from "@/services/store-returns";


const WAITING_TONE = "border border-amber-200 bg-amber-50 text-amber-700";
const DONE_TONE = "border border-emerald-200 bg-emerald-50 text-emerald-700";
const lifecycleTone: Record<string, string> = {
	REQUESTED: WAITING_TONE,
	// Yang ini pekerjaan gudang berikutnya, jadi dibuat menonjol.
	REPLACEMENT_PENDING: "border border-sky-300 bg-sky-100 text-sky-800",
	ACCOUNTING_REVIEW: "border border-slate-200 bg-slate-50 text-slate-700",
	CREDITED: DONE_TONE,
	REPLACED: DONE_TONE,
	RETURNED: DONE_TONE,
};
const NEUTRAL_TONE = "border border-slate-200 bg-slate-50 text-slate-700";

const LIFECYCLE_FILTERS: Array<{ value: ReturnLifecycleStatus; label: string }> = [
	{ value: "REQUESTED", label: "Menunggu pemeriksaan gudang" },
	{ value: "REPLACEMENT_PENDING", label: "Menunggu DO pengganti" },
	{ value: "ACCOUNTING_REVIEW", label: "Menunggu keputusan akuntan" },
];

const reviewSuccessMessage: Record<string, string> = {
	REJECTED: "Retur ditolak.",
	ACCOUNTING_REVIEW: "Barang diterima dan diteruskan ke review akuntan.",
	REPLACEMENT_PENDING: "Barang diterima dan masuk antrean penggantian.",
	RETURNED: "Barang diterima. Retur barang selesai dan tagihan sudah disesuaikan.",
};

type GudangDecision = "APPROVED_GOOD" | "APPROVED_DAMAGED" | "REJECTED";
const PAGE_SIZE = 10;

interface ReviewItemDraft {
	returnItemId: string;
	productName: string;
	requestedQuantity: number;
	receivedQuantity: string;
	approvedCondition: StoreReturnItemCondition;
	warehouseNotes: string;
}

const requestedConditionLabel: Record<StoreReturnItemCondition, string> = {
	GOOD: "Salah Kirim / Barang Masih Baik",
	DAMAGED: "Rusak",
};

const getRequestedConditionSummary = (request: StoreReturnRequestItem) => {
	const requestedConditions = Array.from(
		new Set(request.items.map((item) => item.requestedCondition)),
	);
	if (requestedConditions.length === 1) {
		return requestedConditionLabel[requestedConditions[0]];
	}
	return requestedConditions
		.map((condition) => requestedConditionLabel[condition])
		.join(", ");
};

const getReviewErrorMessage = (error: unknown) => {
	const message = getApiErrorMessage(error, "Gagal memproses verifikasi retur.");
	if (message === "RETURN_REJECTION_REASON_REQUIRED" || message.includes("warehouse note is required")) {
		return "Catatan hasil wajib diisi untuk barang yang ditolak.";
	}
	if (message.includes("Received quantity exceeds requested quantity")) {
		return "Jumlah diterima tidak boleh melebihi jumlah yang diajukan.";
	}
	return message;
};

export default function ReturBarangPage() {
	const [requests, setRequests] = useState<StoreReturnRequestItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [lifecycleFilter, setLifecycleFilter] = useState<ReturnLifecycleStatus | "">("");
	const [page, setPage] = useState(1);
	const [totalItems, setTotalItems] = useState(0);
	const [totalPages, setTotalPages] = useState(1);
	const [activeRequest, setActiveRequest] =
		useState<StoreReturnRequestItem | null>(null);
	const [verificationNote, setVerificationNote] = useState("");
	const [decision, setDecision] = useState<GudangDecision>("APPROVED_GOOD");
	const [reviewItems, setReviewItems] = useState<ReviewItemDraft[]>([]);

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const result = await storeReturnsService.list({
				page,
				limit: PAGE_SIZE,
				search: debouncedSearch || undefined,
				lifecycleStatus: lifecycleFilter || undefined,
				sortBy: "submittedAt",
				sortOrder: "desc",
			});
			setRequests(result.items);
			setTotalItems(result.meta?.totalItems ?? result.items.length);
			const nextTotalPages = Math.max(1, result.meta?.totalPages ?? 1);
			setTotalPages(nextTotalPages);
			if (page > nextTotalPages) setPage(nextTotalPages);
		} catch (loadError: unknown) {
			setError(
				getApiErrorMessage(
					loadError,
					"Gagal memuat pengajuan retur barang.",
				),
			);
		} finally {
			setLoading(false);
		}
	}, [debouncedSearch, lifecycleFilter, page]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setDebouncedSearch(search.trim());
			setPage(1);
		}, 350);
		return () => window.clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void load();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [load]);

	const summary = useMemo(
		() => ({
			pending: requests.filter((item) => item.status === "PENDING").length,
			approved: requests.filter(
				(item) =>
					item.status === "APPROVED_GOOD" ||
					item.status === "APPROVED_DAMAGED" ||
					item.status === "PARTIALLY_APPROVED",
			).length,
			rejected: requests.filter((item) => item.status === "REJECTED").length,
		}),
		[requests],
	);
	const orderedReturnItems = useMemo(() => {
		if (!activeRequest) return [];
		return [...activeRequest.items].sort((left, right) => {
			const productOrder = left.productNameSnapshot.localeCompare(right.productNameSnapshot, "id");
			if (productOrder !== 0) return productOrder;
			return left.requestedCondition.localeCompare(right.requestedCondition);
		});
	}, [activeRequest]);
	const reviewItemsById = useMemo(
		() => new Map(reviewItems.map((item) => [item.returnItemId, item])),
		[reviewItems],
	);
	const settlementPreview = useMemo(() => {
		if (!activeRequest) return { approvedAmount: 0, invoiceAdjustment: 0, storeCredit: 0 };
		if (activeRequest.lifecycleStatus !== "REQUESTED") return {
			approvedAmount: activeRequest.approvedAmount,
			invoiceAdjustment: activeRequest.invoiceAdjustmentAmount,
			storeCredit: activeRequest.storeCreditAmount,
		};
		const approvedAmount = activeRequest.items.reduce((total, item) => {
			const received = Math.max(0, Math.floor(Number(reviewItemsById.get(item.id)?.receivedQuantity) || 0));
			return total + received * item.unitPriceSnapshot;
		}, 0);
		const invoiceAdjustment = Math.min(approvedAmount, activeRequest.invoice?.remainingAmount ?? 0);
		return {
			approvedAmount,
			invoiceAdjustment,
			storeCredit: activeRequest.excessResolution === "STORE_CREDIT" ? Math.max(0, approvedAmount - invoiceAdjustment) : 0,
		};
	}, [activeRequest, reviewItemsById]);

	const currentPage = Math.min(page, totalPages);
	const paginatedRequests = requests;

	const openDetail = (request: StoreReturnRequestItem) => {
		setActiveRequest(request);
		setDecision("APPROVED_GOOD");
		setVerificationNote(request.reviewNote || "");
		setReviewItems(
			request.items.map((item) => ({
				returnItemId: item.id,
				productName: item.productNameSnapshot,
				requestedQuantity: item.quantity,
				receivedQuantity: String(item.quantity),
				approvedCondition: item.requestedCondition,
				warehouseNotes: item.warehouseNotes ?? "",
			})),
		);
	};

	const applyDecision = async () => {
		if (!activeRequest) {
			return;
		}

		setSaving(true);
		setError("");
		setSuccess("");
		try {
			const reviewedItems = reviewItems.map((item) => ({
				returnItemId: item.returnItemId,
				receivedQuantity: Math.max(0, Math.floor(Number(item.receivedQuantity) || 0)),
				approvedCondition: item.approvedCondition,
				warehouseNotes: item.warehouseNotes.trim() || undefined,
			}));
			if (decision !== "REJECTED") {
				const invalidItem = reviewedItems.find(
					(item, index) => item.receivedQuantity > reviewItems[index].requestedQuantity,
				);
				if (invalidItem) {
					setError("Jumlah diterima tidak boleh melebihi jumlah yang diajukan.");
					setSaving(false);
					return;
				}
				if (!reviewedItems.some((item) => item.receivedQuantity > 0)) {
					setError("Isi minimal satu jumlah barang yang diterima, atau pilih Tolak Seluruh Retur.");
					setSaving(false);
					return;
				}
				const missingRejectionReason = reviewedItems.find(
					(item, index) =>
						item.receivedQuantity < reviewItems[index].requestedQuantity && !item.warehouseNotes,
				);
				if (missingRejectionReason) {
					setError("Isi catatan hasil untuk setiap barang yang ditolak sebagian.");
					setSaving(false);
					return;
				}
			}
			if (decision === "REJECTED" && !verificationNote.trim()) {
				setError("Isi alasan penolakan. Alasan ini akan diterapkan ke seluruh item.");
				setSaving(false);
				return;
			}
			const resolvedDecision: GudangDecision =
				decision === "REJECTED"
					? "REJECTED"
					: reviewedItems.some(
							(item) => item.receivedQuantity > 0 && item.approvedCondition === "DAMAGED",
						)
						? "APPROVED_DAMAGED"
						: "APPROVED_GOOD";
			const reviewed = await storeReturnsService.review(activeRequest.id, {
				decision: resolvedDecision,
				reviewNote: verificationNote.trim() || undefined,
				items:
					decision === "REJECTED"
						? reviewedItems.map((item) => ({
							...item,
							receivedQuantity: 0,
							warehouseNotes: verificationNote.trim(),
						}))
						: reviewedItems,
			});

			// Pesannya mengikuti status hasil dari server, bukan tebakan dari pilihan toko.
			setSuccess(reviewSuccessMessage[reviewed.lifecycleStatus ?? ""] ?? "Verifikasi retur berhasil diproses.");
			setActiveRequest(null);
			setVerificationNote("");
			setReviewItems([]);
			await load();
		} catch (submitError: unknown) {
			setError(getReviewErrorMessage(submitError));
		} finally {
			setSaving(false);
		}
	};

	const acceptAllItems = () => {
		setDecision("APPROVED_GOOD");
		setReviewItems((current) =>
			current.map((item) => ({
				...item,
				receivedQuantity: String(item.requestedQuantity),
				warehouseNotes: "",
			})),
		);
	};

	const rejectAllItems = () => {
		setDecision("REJECTED");
		setReviewItems((current) => current.map((item) => ({ ...item, receivedQuantity: "0" })));
	};

	const resetReviewItems = () => {
		if (!activeRequest) return;
		setDecision("APPROVED_GOOD");
		setVerificationNote(activeRequest.reviewNote || "");
		setReviewItems(
			activeRequest.items.map((item) => ({
				returnItemId: item.id,
				productName: item.productNameSnapshot,
				requestedQuantity: item.quantity,
				receivedQuantity: String(item.quantity),
				approvedCondition: item.requestedCondition,
				warehouseNotes: "",
			})),
		);
	};

	return (
		<FeaturePage
			title="Retur Barang"
			description="Gudang memverifikasi pengajuan retur yang sudah diklasifikasikan toko. Jika toko mengajukan salah kirim maka barang kembali ke stok baik, jika rusak maka barang masuk pencatatan barang rusak setelah dicek gudang."
		>
			<PageFeedback
				error={error}
				success={success}
				onDismissError={() => setError("")}
				onDismissSuccess={() => setSuccess("")}
			/>

			<section className="grid gap-4 md:grid-cols-4">
				{[
					{ label: "Total Hasil", value: totalItems },
					{ label: "Menunggu di Halaman", value: summary.pending },
					{ label: "Disetujui di Halaman", value: summary.approved },
					{ label: "Ditolak di Halaman", value: summary.rejected },
				].map((item) => (
					<div
						key={item.label}
						className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
					>
						<p className="text-xs uppercase tracking-[0.18em] text-slate-500">
							{item.label}
						</p>
						<p className="mt-2 text-2xl font-semibold text-slate-900">
							{item.value}
						</p>
					</div>
				))}
			</section>

			<section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
				Toko sekarang menentukan dulu alasan retur dan klasifikasi awal barang:
				<span className="font-semibold text-slate-900"> rusak</span> atau
				<span className="font-semibold text-slate-900">
					{" "}
					salah kirim / masih baik
				</span>
				. Gudang tinggal memverifikasi klasifikasi tersebut saat barang fisik
				dicek.
			</section>

			<section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
				<div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
					<div>
						<h2 className="font-semibold text-slate-900">Riwayat Retur</h2>
						<p className="mt-1 text-xs text-slate-500">
							Menampilkan {requests.length} dari {totalItems} pengajuan.
						</p>
					</div>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<input
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setPage(1);
							}}
							placeholder="Cari request, toko, invoice, item..."
							className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm sm:w-72"
						/>
						<select
							aria-label="Filter tahap retur"
							value={lifecycleFilter}
							onChange={(event) => {
								setLifecycleFilter(event.target.value as ReturnLifecycleStatus | "");
								setPage(1);
							}}
							className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm sm:w-64"
						>
							<option value="">Semua tahap</option>
							{LIFECYCLE_FILTERS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
				</div>
				<table className="min-w-full divide-y divide-slate-200 text-sm">
					<thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
						<tr>
							<th className="px-4 py-3">Request</th>
							<th className="px-4 py-3">Toko</th>
							<th className="px-4 py-3">Invoice</th>
							<th className="px-4 py-3">Status</th>
							<th className="px-4 py-3 text-right">Aksi</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-slate-100">
						{loading ? (
							<tr>
								<td colSpan={5} className="px-4 py-4 text-slate-600">
									Memuat retur barang...
								</td>
							</tr>
						) : requests.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-4 py-4 text-slate-600">
									Tidak ada pengajuan retur yang sesuai pencarian.
								</td>
							</tr>
						) : (
							paginatedRequests.map((request) => (
								<tr key={request.id}>
									<td className="px-4 py-3">
										<div className="font-medium text-slate-900">
											{request.requestNumber}
										</div>
										<div className="text-xs text-slate-500">
											{formatAppDateTime(request.submittedAt)}
										</div>
									</td>
									<td className="px-4 py-3 text-slate-700">
										{request.store?.name ?? "-"}
									</td>
									<td className="px-4 py-3 text-slate-700">
										<div>
											{request.invoice?.invoiceNumber ?? "-"}
										</div>
										<div className="text-xs text-slate-500">
											Diterima {formatAppDateTime(request.invoice?.deliveryOrder?.receivedAt)}
										</div>
									</td>
									<td className="px-4 py-3">
										<span
											className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${lifecycleTone[request.lifecycleStatus ?? ""] ?? NEUTRAL_TONE}`}
										>
											{returnLifecycleLabel[request.lifecycleStatus ?? ""] ?? request.status}
										</span>
									</td>
									<td className="px-4 py-3 text-right">
										<button
											type="button"
											onClick={() => openDetail(request)}
											className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
										>
											Detail
										</button>
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
				<PaginationControls
					currentPage={currentPage}
					totalPages={totalPages}
					totalItems={totalItems}
					currentItemCount={paginatedRequests.length}
					pageSize={PAGE_SIZE}
					itemLabel="retur"
					onPageChange={setPage}
				/>
			</section>

			<Modal
				isOpen={Boolean(activeRequest)}
				onClose={() => setActiveRequest(null)}
				title="Detail Retur Barang"
				maxWidthClassName="max-w-7xl"
			>
				{activeRequest ? (
					<div className="space-y-4">
						<div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 md:grid-cols-2">
							<div>
								<p className="text-xs text-slate-500">Nomor Retur</p>
								<p className="font-semibold text-slate-900">
									{activeRequest.requestNumber}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Tanggal Pengajuan</p>
								<p className="font-semibold text-slate-900">
									{formatAppDateTime(activeRequest.submittedAt)}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Toko</p>
								<p className="font-semibold text-slate-900">
									{activeRequest.store?.name ?? "-"}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Invoice</p>
								<p className="font-semibold text-slate-900">
									{activeRequest.invoice?.invoiceNumber ?? "-"}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Gudang Tujuan Retur</p>
								<p className="font-semibold text-slate-900">
									{activeRequest.sourceWarehouse?.name ?? "-"}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Potong Piutang</p>
								<p className="font-semibold text-slate-900">
									{formatRupiah(activeRequest.receivableAdjustmentAmount)}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Klasifikasi Toko</p>
								<p className="font-semibold text-slate-900">
									{getRequestedConditionSummary(activeRequest)}
								</p>
							</div>
							<div>
								<p className="text-xs text-slate-500">Status</p>
								<span
									className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${lifecycleTone[activeRequest.lifecycleStatus ?? ""] ?? NEUTRAL_TONE}`}
								>
									{returnLifecycleLabel[activeRequest.lifecycleStatus ?? ""] ?? activeRequest.status}
								</span>
							</div>
							<div className="md:col-span-2">
								<p className="text-xs text-slate-500">Alasan dari Toko</p>
								<p className="mt-1 font-medium text-slate-900">{activeRequest.reason}</p>
								<p className="mt-1 text-slate-600">{activeRequest.note || "-"}</p>
							</div>
						</div>
						<div className="grid gap-3 md:grid-cols-3">
							<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm"><p className="text-xs text-slate-500">Penyelesaian Toko</p><p className="mt-1 font-semibold text-slate-900">{activeRequest.excessResolution === "REPLACEMENT" ? "Barang Pengganti" : "Saldo Toko"}</p><p className="mt-1 text-xs text-slate-500">Informasi saja; nominal dihitung sistem.</p></div>
							<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm"><p className="text-xs text-slate-500">{activeRequest.status === "PENDING" ? "Estimasi Tagihan Dibatalkan" : "Tagihan Dibatalkan"}</p><p className="mt-1 font-semibold text-slate-900">{formatRupiah(settlementPreview.invoiceAdjustment)}</p></div>
							<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm"><p className="text-xs text-slate-500">{activeRequest.status === "PENDING" ? "Estimasi Saldo Toko" : "Saldo Toko"}</p><p className="mt-1 font-semibold text-slate-900">{formatRupiah(settlementPreview.storeCredit)}</p></div>
						</div>
						{activeRequest.excessResolution === "REPLACEMENT" ? <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">Jika ada barang yang diterima, sistem akan membuat DO pengganti untuk produk dan qty yang sama. Pemenuhannya tetap mengikuti stok dan transfer gudang biasa.</div> : null}
						{activeRequest.replacementDeliveryOrder ? <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">DO Pengganti: <span className="font-semibold">{activeRequest.replacementDeliveryOrder.deliveryOrderNumber}</span> · {activeRequest.replacementDeliveryOrder.status}</div> : null}
						<div className="overflow-hidden rounded-xl border border-slate-200">
							<div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
								<h3 className="text-sm font-semibold text-slate-900">Barang yang Diretur</h3>
								<p className="mt-1 text-xs text-slate-500">Item diurutkan berdasarkan nama produk agar variasi kondisi retur untuk barang yang sama tampil berdampingan.</p>
							</div>
							<div className="overflow-x-auto">
							<table className="min-w-[1050px] divide-y divide-slate-200 text-sm">
								<thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
									<tr>
										<th className="px-3 py-2">Barang</th>
										<th className="px-3 py-2 text-right">Diajukan</th>
										<th className="px-3 py-2 text-right">Diterima</th>
										<th className="px-3 py-2 text-right">Ditolak</th>
										<th className="px-3 py-2">Klasifikasi Toko</th>
										<th className="px-3 py-2">Hasil Gudang</th>
										<th className="px-3 py-2">Catatan Hasil</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-100">
									{orderedReturnItems.map((item) => {
										const reviewItem = reviewItemsById.get(item.id);
										const receivedQuantity = activeRequest.lifecycleStatus === "REQUESTED"
											? Math.max(0, Math.floor(Number(reviewItem?.receivedQuantity) || 0))
											: item.receivedQuantity ?? 0;
										return (
										<tr key={item.id}>
											<td className="px-3 py-2 text-slate-700">
												{item.productNameSnapshot}
											</td>
											<td className="px-3 py-2 text-right text-slate-900">
												{item.quantity}
											</td>
											<td className="px-3 py-2 text-right text-slate-900">
												{activeRequest.lifecycleStatus === "REQUESTED" ? (
													<input
														type="number"
														min={0}
														max={item.quantity}
														value={reviewItem?.receivedQuantity ?? "0"}
														onChange={(event) =>
															setReviewItems((current) =>
																current.map((row) =>
																	row.returnItemId === item.id
																		? { ...row, receivedQuantity: event.target.value }
																		: row,
																),
															)
														}
														className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-right"
													/>
												) : (
													item.receivedQuantity ?? item.quantity
												)}
											</td>
											<td className="px-3 py-2 text-right font-medium text-rose-700">
												{Math.max(
													0,
													item.quantity -
																		receivedQuantity,
												)}
											</td>
											<td className="px-3 py-2 text-slate-700">
												{requestedConditionLabel[item.requestedCondition]}
											</td>
											<td className="px-3 py-2 text-slate-700">
												{activeRequest.lifecycleStatus === "REQUESTED" ? (
													<select
														value={reviewItem?.approvedCondition ?? item.requestedCondition}
														onChange={(event) =>
															setReviewItems((current) =>
																current.map((row) =>
																	row.returnItemId === item.id
																		? {
																				...row,
																				approvedCondition: event.target.value as StoreReturnItemCondition,
																			}
																		: row,
																),
															)
														}
														className="rounded-lg border border-slate-300 px-2 py-1.5"
													>
														<option value="GOOD">Barang Bagus</option>
														<option value="DAMAGED">Barang Rusak</option>
													</select>
												) : (
													item.approvedCondition
														? requestedConditionLabel[item.approvedCondition]
														: "-"
												)}
											</td>
											<td className="px-3 py-2 text-slate-700">
												{activeRequest.lifecycleStatus === "REQUESTED" ? (
													<textarea
														value={reviewItem?.warehouseNotes ?? ""}
														onChange={(event) =>
															setReviewItems((current) =>
																current.map((row) =>
																	row.returnItemId === item.id ? { ...row, warehouseNotes: event.target.value } : row,
																),
															)
														}
														placeholder="Wajib bila qty ditolak"
														className="min-h-16 min-w-48 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
													/>
												) : (
													item.warehouseNotes || "-"
												)}
											</td>
										</tr>
										);
									})}
								</tbody>
							</table>
							</div>
						</div>
						{activeRequest.reviewNote ? (
							<div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
								<p className="text-xs text-slate-500">Catatan Verifikasi Gudang</p>
								<p className="mt-1">{activeRequest.reviewNote}</p>
							</div>
						) : null}
						{activeRequest.lifecycleStatus === "REQUESTED" ? (
							<>
								<div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
									<p className="mb-3 font-semibold text-slate-900">Hasil Pemeriksaan Gudang</p>
									<div className="flex flex-wrap gap-2">
										<button type="button" onClick={acceptAllItems} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">Terima Semua</button>
										<button type="button" onClick={rejectAllItems} className={`rounded-lg px-3 py-2 text-xs font-semibold ${decision === "REJECTED" ? "bg-rose-600 text-white" : "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"}`}>Tolak Semua</button>
										<button type="button" onClick={resetReviewItems} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Reset ke Pengajuan</button>
									</div>
									<p className="mt-3 text-slate-600">
										{decision === "REJECTED"
											? "Seluruh pengajuan akan ditolak. Isi satu alasan di bawah; alasan tersebut diterapkan ke setiap item."
											: "Isi jumlah fisik yang benar-benar diterima. Qty ditolak dihitung otomatis; catatan hasil wajib untuk setiap baris yang ditolak sebagian."}
									</p>
								</div>
								<label className="block space-y-2 text-sm text-slate-700">
									<span>{decision === "REJECTED" ? "Alasan Tolak Seluruh Retur" : "Catatan Umum Verifikasi Gudang"}</span>
									<textarea
										className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2"
										value={verificationNote}
										onChange={(event) => setVerificationNote(event.target.value)}
									/>
								</label>
							</>
						) : null}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setActiveRequest(null)}
								className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700"
							>
								Batal
							</button>
							{activeRequest.lifecycleStatus === "REQUESTED" ? (
								<button
									type="button"
									onClick={() => void applyDecision()}
									disabled={saving}
									className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
								>
									{saving ? "Menyimpan..." : "Simpan Keputusan"}
								</button>
							) : null}
							{activeRequest.lifecycleStatus === "REPLACEMENT_PENDING" ? (
								<button type="button" onClick={() => void (async () => { setSaving(true); try { await storeReturnsService.createReplacementDeliveryOrder(activeRequest.id); setSuccess("DO barang pengganti berhasil dibuat."); setActiveRequest(null); await load(); } catch (replacementError) { setError(getReviewErrorMessage(replacementError)); } finally { setSaving(false); } })()} disabled={saving} className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
									{saving ? "Membuat..." : "Buat DO Pengganti"}
								</button>
							) : null}
						</div>
					</div>
				) : null}
			</Modal>
		</FeaturePage>
	);
}
