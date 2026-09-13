import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { DeliveryStatus, StoredSubmission, Submission, SubmissionStore } from './SubmissionService.js';

export class SubmissionRepository implements SubmissionStore {
  public constructor(private readonly pool: Pool) {}
  public async find(accountId: string, id: string): Promise<StoredSubmission | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT document, status FROM submissions WHERE user_id = ? AND id = ?', [accountId, id]);
    const row = rows[0];
    return row ? { document: typeof row.document === 'string' ? JSON.parse(row.document) : row.document, status: row.status } : undefined;
  }
  public async checkQuota(accountId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT
      SUM(user_id = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 1 MINUTE) AS recent,
      SUM(user_id = ?) AS daily,
      SUM(created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS hourly
      FROM submissions WHERE created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY`, [accountId, accountId]);
    return Number(rows[0].recent) < 1 && Number(rows[0].daily) < 10 && Number(rows[0].hourly) < 100;
  }
  public async insert(document: Submission): Promise<void> {
    await this.pool.execute('INSERT INTO submissions (user_id, id, kind, document, status) VALUES (?, ?, ?, ?, ?)', [document.author.accountId, document.id, document.design.kind, JSON.stringify(document), 'PENDING']);
  }
  public async mark(accountId: string, id: string, status: DeliveryStatus): Promise<void> {
    await this.pool.execute('UPDATE submissions SET status = ? WHERE user_id = ? AND id = ?', [status, accountId, id]);
  }
}
