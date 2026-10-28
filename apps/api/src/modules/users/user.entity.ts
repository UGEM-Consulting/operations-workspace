import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
export enum Role { SYSTEM_ADMIN = 'SYSTEM_ADMIN', DISPATCHER_MANAGER = 'DISPATCHER_MANAGER', IT_SPECIALIST = 'IT_SPECIALIST' }
export enum UserStatus { ACTIVE = 'ACTIVE', INACTIVE = 'INACTIVE' }
@Entity('users')
@Index('users_email_lower_unique', { synchronize: false })
export class User {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ length: 100 }) firstName!: string;
  @Column({ length: 100 }) lastName!: string;
  @Column({ length: 254 }) email!: string;
  @Column({ type: 'text', nullable: true, select: false }) passwordHash!: string | null;
  @Column({ type: 'enum', enum: Role, enumName: 'user_role' }) role!: Role;
  @Column({ type: 'enum', enum: UserStatus, enumName: 'user_status', default: UserStatus.ACTIVE }) status!: UserStatus;
  @Column({ default: 1, select: false }) authVersion!: number;
  // Set when an administrator chose the password; sign-in then requires a new one before any staff access.
  @Column({ default: false }) mustChangePassword!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
  @Column({ type: 'timestamptz', nullable: true }) lastLoginAt!: Date | null;
}
export function publicUser(user: User) {
  return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt, updatedAt: user.updatedAt, lastLoginAt: user.lastLoginAt };
}
