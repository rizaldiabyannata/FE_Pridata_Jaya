"use client";

export const dynamic = "force-dynamic";
import { Fragment, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AgingReceivableDetailModal, {
	riskLabel,
	riskTone,
} from "@/components/akuntan/AgingReceivableDetailModal";
import { FeaturePage } from "@/components/shared/FeaturePage";
import PageFeedback from "@/components/shared/PageFeedback";
import PaginationControls from "@/components/shared/PaginationControls";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePagedList } from "@/hooks/usePagedList";
import { useServerValue } from "@/hooks/useServerValue";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatRupiah } from "@/lib/format";
import { daysOverdueLabel, invoiceStatusLabel, toUiLabel } from "@/lib/ui-labels";
import {
	receivableService,
	type AgeBucket,
	type ReceivableFilters,
	type ReceivableStoreGroup,
} from "@/services/receivable";

const PAGE_SIZE = 20;

const dateOnly = (value?: string | null) => (value ? String(value).slice(0, 10) : "-");

type StoreFilters = Omit<ReceivableFilters, "storeId">;

type FilterState = {
	search: string;
	status: "ALL" | "UNPAID" | "PARTIAL";
	ageBucket: "ALL" | AgeBucket;
};

// Satu definisi bucket (BE): hari lewat jatuh tempo, dihitung dari 00:00 WITA.
const AGE_BUCKETS: Array<{ value: AgeBucket; label: string }> = [
	{ value: "current", label: "Belum Jatuh Tempo" },
	{ value: "days1To30", label: "1-30 Hari" },
	{ value: "days31To60", label: "31-60 Hari" },
	{ value: "days61To90", label: "61-90 Hari" },
	{ value: "daysOver90", label: ">90 Hari" },
];

/** Angka headline: "—" selama ringkasan belum ada (memuat atau gagal), bukan 0 yang menyesatkan. */
const headline = (value: number | undefined, format: (value: number) => string | number = (v) => v) =>
	value === undefined ? "—" : format(value);

/** Invoice satu toko: dimuat saat baris dibuka, satu halaman dari server. */
function StoreReceivableRows({
	storeId,
	filters,
	filterKey,
}: {
	storeId: string;
	filters: StoreFilters;
	filterKey: string;
}) {
	const list = usePagedList(
		async (page, limit) => {
			const result = await receivableService.listReceivables({
				...filters,
				storeId,
				page,
				limit,
				sortBy: "invoiceDate",
				sortOrder: "asc",
			});
			return { items: result.data, meta: result.meta };
		},
		{
			filterKey: `${storeId}|${filterKey}`,
			errorMessage: "Gagal memuat invoice piutang toko.",
			pageSize: PAGE_SIZE,
		},
	);

	return (
		<div className="overflow-x-auto px-4 py-3">
			{list.error ? (
				<p role="alert" className="mb-2 text-xs text-rose-700">
					{list.error}{" "}
					<button type="button" onClick={list.reload} className="font-semibold underline">
						Coba lagi
					</button>
				</p>
			) : null}
			<table className="min-w-full text-xs">
				<thead className="text-left text-slate-500">
					<tr className="border-b border-slate-200">
						<th className="px-2 py-2">Invoice</th>
						<th className="px-2 py-2">Tanggal Invoice</th>
						<th className="px-2 py-2">Jatuh Tempo</th>
						<th className="px-2 py-2 text-right">Total</th>
						<th className="px-2 py-2 text-right">Sisa</th>
						<th className="px-2 py-2 text-center">Lewat Jatuh Tempo</th>
						<th className="px-2 py-2">Status</th>
					</tr>
				</thead>
				<tbody>
					{list.items.length === 0 ? (
						<tr>
							<td className="px-2 py-2 text-slate-600" colSpan={7}>
								{list.loading
									? "Memuat invoice piutang..."
									: list.error
										? "Invoice piutang belum bisa dimuat."
										: "Tidak ada invoice piutang pada filter ini."}
							</td>
						</tr>
					) : (
						list.items.map((item) => (
							<tr key={item.id} className="border-b border-slate-200/80">
								<td className="px-2 py-2 text-slate-700">{item.invoiceNumber}</td>
								<td className="px-2 py-2 text-slate-700">{dateOnly(item.invoiceDate)}</td>
								<td className="px-2 py-2 text-slate-700">{dateOnly(item.dueDate)}</td>
								<td className="px-2 py-2 text-right text-slate-700">
									{formatRupiah(item.amount ?? item.totalAmount ?? 0)}
								</td>
								<td className="px-2 py-2 text-right font-semibold text-rose-700">
									{formatRupiah(item.remainingAmount)}
								</td>
								<td className="px-2 py-2 text-center text-slate-700">
									{daysOverdueLabel(item.daysOverdue)}
								</td>
								<td className="px-2 py-2 text-slate-700">
									{toUiLabel(item.status, invoiceStatusLabel)}
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
			{list.totalPages > 1 ? (
				<PaginationControls
					currentPage={list.page}
					totalPages={list.totalPages}
					totalItems={list.totalItems}
					currentItemCount={list.items.length}
					pageSize={PAGE_SIZE}
					itemLabel="invoice"
					loading={list.loading}
					onPageChange={list.setPage}
				/>
			) : null}
		</div>
	);
}

function AgingPiutangPageContent() {
	const searchParams = useSearchParams();
	const [filters, setFilters] = useState<FilterState>(() => ({
		search: (searchParams.get("search") ?? "").slice(0, 100),
		status: "ALL",
		ageBucket: "ALL",
	}));
	const [actionError, setActionError] = useState("");
	const [success, setSuccess] = useState("");
	const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
	const [selectedGroup, setSelectedGroup] = useState<ReceivableStoreGroup | null>(null);
	const [expandedStoreIds, setExpandedStoreIds] = useState<string[]>([]);

	const debouncedSearch = useDebouncedValue(filters.search.trim());
	const serverFilters: StoreFilters = {
		search: debouncedSearch || undefined,
		status: filters.status === "ALL" ? undefined : filters.status,
		ageBucket: filters.ageBucket === "ALL" ? undefined : filters.ageBucket,
	};
	const filterKey = `${debouncedSearch}|${filters.status}|${filters.ageBucket}`;

	const list = usePagedList(
		(page, limit) => receivableService.listStoreGroups({ ...serverFilters, page, limit }),
		{ filterKey, errorMessage: "Gagal memuat aging piutang.", pageSize: PAGE_SIZE },
	);
	// Satu panggilan untuk semua kartu: lima bucket mengabaikan `ageBucket`, empat total mengikutinya.
	const aging = useServerValue(() => receivableService.getAging(serverFilters), {
		key: filterKey,
		errorMessage: "Gagal memuat ringkasan aging piutang.",
	});
	const summary = aging.data ?? undefined;

	const loadError = list.error || aging.error;
	const retryLoad = () => {
		if (list.error) list.reload();
		if (aging.error) aging.reload();
	};

	const handleExport = async (format: "pdf" | "csv") => {
		setExporting(format);
		setActionError("");
		setSuccess("");
		try {
			await receivableService.exportReceivables(format, {
				search: filters.search.trim() || undefined,
				status: serverFilters.status,
				ageBucket: serverFilters.ageBucket,
				sortBy: "invoiceDate",
				sortOrder: "asc",
			});
			setSuccess("Export aging piutang dibuat. Cek status dan download di menu Log Ekspor.");
		} catch (exportError: unknown) {
			setActionError(getApiErrorMessage(exportError, "Gagal membuat export aging piutang."));
		} finally {
			setExporting(null);
		}
	};

	const toggleExpanded = (storeId: string) => {
		setExpandedStoreIds((current) =>
			current.includes(storeId) ? current.filter((value) => value !== storeId) : [...current, storeId],
		);
	};

	return (
		<FeaturePage
			title="Aging Piutang"
			description="Pantau umur piutang toko agar penagihan bisa diprioritaskan secara berkala. Umur piutang dihitung dari tanggal jatuh tempo (hari lewat jatuh tempo), bukan dari tanggal invoice."
			actions={[
				{
					label: exporting === "pdf" ? "Ekspor PDF..." : "Ekspor PDF",
					onClick: () => {
						if (exporting) return;
						void handleExport("pdf");
					},
				},
				{
					label: exporting === "csv" ? "Ekspor CSV..." : "Ekspor CSV",
					onClick: () => {
						if (exporting) return;
						void handleExport("csv");
					},
				},
			]}
		>
			<PageFeedback
				error={actionError || loadError}
				success={success}
				// Galat muat tidak bisa ditutup: tanpanya tabel tampak kosong atau angka tampak "—" tanpa sebab.
				onDismissError={actionError ? () => setActionError("") : undefined}
				onDismissSuccess={() => setSuccess("")}
				onRetry={actionError ? undefined : retryLoad}
			/>

			<section className="grid gap-4 md:grid-cols-3">
				<div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
					<p className="text-sm text-slate-500">Total Piutang</p>
					<p className="mt-2 text-2xl font-semibold text-slate-900">
						{headline(summary?.totalOutstandingAmount, formatRupiah)}
					</p>
				</div>
				<div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
					<p className="text-sm text-slate-500">Invoice Berjalan</p>
					<p className="mt-2 text-3xl font-semibold text-slate-900">{headline(summary?.totalReceivables)}</p>
				</div>
				<div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
					<p className="text-sm text-slate-500">Perlu Ditagih (&gt;30 Hari)</p>
					<p className="mt-2 text-3xl font-semibold text-rose-600">{headline(summary?.overdueOver30Count)}</p>
					<p className="mt-1 text-xs text-slate-500">Lewat jatuh tempo lebih dari 30 hari</p>
				</div>
			</section>

			<section className="space-y-2">
				<p className="text-xs text-slate-500">
					Umur piutang dihitung dari tanggal jatuh tempo: jumlah hari lewat jatuh tempo per hari ini (WITA).
				</p>
				<div className="grid gap-4 md:grid-cols-5">
					{AGE_BUCKETS.map(({ value, label }) => (
						<div key={value} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
							<p className="text-sm text-slate-500">{label}</p>
							<p className="mt-2 text-2xl font-semibold text-slate-900">{headline(summary?.[value].count)}</p>
							<p className="mt-1 text-sm text-slate-600">{headline(summary?.[value].amount, formatRupiah)}</p>
						</div>
					))}
				</div>
			</section>

			<section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
				<div className="grid gap-3 md:grid-cols-3">
					<input
						className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
						placeholder="Cari invoice atau nama toko"
						aria-label="Cari invoice atau nama toko"
						maxLength={100}
						value={filters.search}
						onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
					/>
					<select
						value={filters.status}
						aria-label="Status invoice"
						onChange={(event) =>
							setFilters((prev) => ({ ...prev, status: event.target.value as FilterState["status"] }))
						}
						className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
					>
						<option value="ALL">Semua Status</option>
						<option value="UNPAID">Belum Lunas</option>
						<option value="PARTIAL">Bayar Sebagian</option>
					</select>
					<select
						value={filters.ageBucket}
						aria-label="Umur piutang"
						onChange={(event) =>
							setFilters((prev) => ({ ...prev, ageBucket: event.target.value as FilterState["ageBucket"] }))
						}
						className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
					>
						<option value="ALL">Semua Umur Piutang</option>
						{AGE_BUCKETS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.value === "current" ? option.label : `${option.label} Lewat Jatuh Tempo`}
							</option>
						))}
					</select>
				</div>
			</section>

			<section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
				<div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 text-sm text-slate-600">
					<p>
						{list.totalItems} toko dengan {headline(summary?.totalReceivables)} invoice piutang.
					</p>
					<p>{list.loading ? "Memuat..." : "Siap ditinjau per toko"}</p>
				</div>
				<div className="overflow-x-auto">
					<table className="min-w-full divide-y divide-slate-200 text-sm">
						<thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
							<tr>
								<th className="w-12 px-4 py-3" />
								<th className="px-4 py-3">Toko</th>
								<th className="px-4 py-3 text-right">Invoice</th>
								<th className="px-4 py-3 text-right">Sisa Tagihan</th>
								<th className="px-4 py-3">Risiko</th>
								<th className="px-4 py-3 text-right">Aksi</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100">
							{list.items.length === 0 ? (
								<tr>
									<td className="px-4 py-4 text-slate-600" colSpan={6}>
										{list.loading
											? "Memuat piutang..."
											: list.error
												? "Aging piutang belum bisa dimuat."
												: "Tidak ada piutang pada filter ini."}
									</td>
								</tr>
							) : (
								list.items.map((group) => {
									const expanded = expandedStoreIds.includes(group.storeId);
									return (
										<Fragment key={group.storeId}>
											<tr className="hover:bg-slate-50">
												<td className="px-4 py-3 text-center">
													<button
														type="button"
														onClick={() => toggleExpanded(group.storeId)}
														aria-expanded={expanded}
														aria-label={`${expanded ? "Tutup" : "Buka"} invoice ${group.storeName || "toko"}`}
														className="rounded-full border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
													>
														{expanded ? "−" : "+"}
													</button>
												</td>
												<td className="px-4 py-3">
													<div className="font-medium text-slate-900">{group.storeName || "Toko"}</div>
												</td>
												<td className="px-4 py-3 text-right text-slate-700">{group.totalInvoiceCount}</td>
												<td className="px-4 py-3 text-right font-semibold text-rose-700">
													{formatRupiah(group.totalOutstandingAmount)}
												</td>
												<td className="px-4 py-3">
													<span
														className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${riskTone(group.maxDaysOverdue)}`}
													>
														{riskLabel(group.maxDaysOverdue)}
													</span>
												</td>
												<td className="px-4 py-3">
													<div className="flex justify-end gap-2">
														<button
															type="button"
															onClick={() => setSelectedGroup(group)}
															className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700"
														>
															Detail
														</button>
													</div>
												</td>
											</tr>
											{expanded ? (
												<tr className="bg-slate-50">
													<td colSpan={6} className="p-0">
														<StoreReceivableRows
															key={group.storeId}
															storeId={group.storeId}
															filters={serverFilters}
															filterKey={filterKey}
														/>
													</td>
												</tr>
											) : null}
										</Fragment>
									);
								})
							)}
						</tbody>
					</table>
				</div>
				<PaginationControls
					currentPage={list.page}
					totalPages={list.totalPages}
					totalItems={list.totalItems}
					currentItemCount={list.items.length}
					pageSize={PAGE_SIZE}
					itemLabel="toko"
					loading={list.loading}
					onPageChange={list.setPage}
				/>
			</section>

			<AgingReceivableDetailModal
				group={selectedGroup}
				filters={serverFilters}
				filterKey={filterKey}
				onClose={() => setSelectedGroup(null)}
			/>
		</FeaturePage>
	);
}

export default function AgingPiutangPage() {
	return (
		<Suspense fallback={
			<div className="flex min-h-[400px] items-center justify-center p-8">
				<div className="text-sm text-slate-500 animate-pulse">Memuat...</div>
			</div>
		}>
			<AgingPiutangPageContent />
		</Suspense>
	);
}
