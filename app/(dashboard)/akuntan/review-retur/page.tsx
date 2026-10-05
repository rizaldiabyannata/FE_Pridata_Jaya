"use client";

import { useState } from "react";
import { FeaturePage } from "@/components/shared/FeaturePage";
import InlineAlert from "@/components/shared/InlineAlert";
import Modal from "@/components/shared/Modal";
import PageFeedback from "@/components/shared/PageFeedback";
import PaginationControls from "@/components/shared/PaginationControls";
import { usePagedList } from "@/hooks/usePagedList";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatRupiah } from "@/lib/format";
import { storeReturnsService, type StoreReturnRequestItem } from "@/services/store-returns";

const PAGE_SIZE = 20;

// Perkiraan saja: server menghitung nilai final pro rata dari subtotal baris invoice (termasuk diskon).
const estimate = (item: StoreReturnRequestItem) =>
	item.items.reduce((sum, line) => sum + (line.receivedQuantity ?? 0) * line.unitPriceSnapshot, 0);

export default function AccountantReturnReviewPage() {
	// Antrean disaring di server: retur tertua yang menunggu keputusan tampil lebih dulu.
	const list = usePagedList(
		(page, limit) =>
			storeReturnsService.list({ page, limit, lifecycleStatus: "ACCOUNTING_REVIEW", sortBy: "submittedAt", sortOrder: "asc" }),
		{ filterKey: "accounting-review", errorMessage: "Gagal memuat antrean review retur.", pageSize: PAGE_SIZE },
	);
	const [selected, setSelected] = useState<StoreReturnRequestItem | null>(null);
	const [note, setNote] = useState("");
	const [actionError, setActionError] = useState("");
	const [success, setSuccess] = useState("");
	const [saving, setSaving] = useState(false);

	const open = (item: StoreReturnRequestItem | null) => {
		setSelected(item);
		setNote("");
		setActionError("");
	};

	const decide = async (action: () => Promise<unknown>, done: string, failed: string) => {
		setSaving(true);
		setActionError("");
		try {
			await action();
			open(null);
			setSuccess(done);
			list.reload();
		} catch (cause: unknown) {
			setActionError(getApiErrorMessage(cause, failed));
		} finally {
			setSaving(false);
		}
	};

	const approve = () => {
		if (!selected) return;
		void decide(
			() => storeReturnsService.approveCredit(selected.id, note.trim() || undefined),
			"Kredit retur disetujui.",
			"Persetujuan kredit gagal diproses.",
		);
	};

	const redirect = () => {
		if (!selected) return;
		if (!note.trim()) {
			setActionError("Alasan penolakan kredit wajib diisi.");
			return;
		}
		void decide(
			() => storeReturnsService.rejectCreditToReplacement(selected.id, note.trim()),
			"Retur dialihkan ke barang pengganti.",
			"Pengalihan ke barang pengganti gagal diproses.",
		);
	};

	return (
		<FeaturePage title="Review Retur" description="Tentukan kompensasi saldo atas barang retur yang telah diterima gudang.">
			<PageFeedback
				error={list.error}
				success={success}
				onRetry={list.reload}
				onDismissSuccess={() => setSuccess("")}
			/>
			<section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
				<table className="min-w-full text-sm">
					<thead className="bg-slate-50 text-left">
						<tr>
							<th className="p-3">Retur</th>
							<th className="p-3">Toko</th>
							<th className="p-3">Invoice</th>
							<th className="p-3 text-right">Estimasi</th>
							<th className="p-3" />
						</tr>
					</thead>
					<tbody>
						{list.items.map((item) => (
							<tr key={item.id} className="border-t">
								<td className="p-3 font-medium">{item.requestNumber}</td>
								<td className="p-3">{item.store?.name}</td>
								<td className="p-3">{item.invoice?.invoiceNumber}</td>
								<td className="p-3 text-right">{formatRupiah(estimate(item))}</td>
								<td className="p-3 text-right">
									<button className="rounded-lg border px-3 py-1.5 text-indigo-700" onClick={() => open(item)}>
										Review
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{!list.items.length ? (
					<p className="p-6 text-center text-slate-500">
						{list.loading
							? "Memuat antrean review retur..."
							: list.error
								? "Antrean review retur belum bisa dimuat."
								: "Tidak ada retur menunggu keputusan akuntan."}
					</p>
				) : null}
				<PaginationControls
					currentPage={list.page}
					totalPages={list.totalPages}
					totalItems={list.totalItems}
					currentItemCount={list.items.length}
					pageSize={PAGE_SIZE}
					itemLabel="retur"
					onPageChange={list.setPage}
				/>
			</section>
			<Modal isOpen={Boolean(selected)} onClose={() => open(null)} title="Keputusan Kredit Retur">
				{selected ? (
					<div className="space-y-4 text-sm">
						<p>
							Nilai mengikuti harga invoice dan kuantitas yang diterima gudang. Sisa tagihan invoice asal akan
							dikurangi terlebih dahulu; nilai lebih langsung masuk ke saldo toko.
						</p>
						<div className="rounded-lg bg-slate-50 p-3">
							Estimasi nilai retur: <strong>{formatRupiah(estimate(selected))}</strong>
							<br />
							Sisa invoice: <strong>{formatRupiah(selected.invoice?.remainingAmount ?? 0)}</strong>
						</div>
						<textarea
							className="min-h-24 w-full rounded-lg border p-2"
							value={note}
							onChange={(event) => setNote(event.target.value)}
							placeholder="Catatan persetujuan atau alasan alihkan ke barang pengganti"
						/>
						{actionError ? <InlineAlert tone="danger">{actionError}</InlineAlert> : null}
						<div className="flex justify-end gap-2">
							<button className="rounded-lg border px-3 py-2" onClick={redirect} disabled={saving}>
								Tolak Kredit → Penggantian
							</button>
							<button className="rounded-lg bg-indigo-600 px-3 py-2 text-white" onClick={approve} disabled={saving}>
								Setujui Kredit
							</button>
						</div>
					</div>
				) : null}
			</Modal>
		</FeaturePage>
	);
}
