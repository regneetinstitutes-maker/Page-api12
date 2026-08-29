CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'deactivated');
CREATE TYPE "public"."mobile_verification_status" AS ENUM('not_started', 'pending', 'verified');
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'superadmin', 'manager', 'support', 'omb_host', 'tournament_host');
CREATE TYPE "public"."wallet_coin_type" AS ENUM('play_coins', 'winning_coins');
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'success', 'failed');
CREATE TYPE "public"."reservation_reason_type" AS ENUM('withdrawal', 'competition_entry', 'tournament_entry', 'admin_hold', 'fraud_hold', 'bonus_hold');
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'confirmed', 'released');
CREATE TYPE "public"."payout_method" AS ENUM('bank_transfer', 'upi');
CREATE TYPE "public"."withdrawal_status" AS ENUM('reserved', 'processing', 'completed', 'failed', 'cancelled');
CREATE TYPE "public"."competition_schedule_status" AS ENUM('draft', 'published', 'closed');
CREATE TYPE "public"."competition_status" AS ENUM('waiting', 'room_available', 'ongoing', 'result_pending', 'completed', 'cancelled');
CREATE TYPE "public"."competition_type" AS ENUM('omb', 'tournament');
CREATE TYPE "public"."host_assignment_type" AS ENUM('omb', 'tournament');
CREATE TYPE "public"."host_status" AS ENUM('active', 'disabled');
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"age" integer NOT NULL,
	"password_hash" text NOT NULL,
	"password_algo" text NOT NULL,
	"email" text,
	"mobile_number" text,
	"mobile_verified_at" timestamp with time zone,
	"mobile_verification_status" "mobile_verification_status" DEFAULT 'not_started' NOT NULL,
	"account_status" "account_status" DEFAULT 'active' NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"failed_login_attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_mobile_number_unique" UNIQUE("mobile_number")
);

CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE "wallet_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_type" "wallet_coin_type" NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"reserved_balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_user_id_wallet_type_unique" UNIQUE("user_id","wallet_type"),
	CONSTRAINT "wallet_accounts_balance_non_negative" CHECK ("wallet_accounts"."balance" >= 0),
	CONSTRAINT "wallet_accounts_reserved_balance_non_negative" CHECK ("wallet_accounts"."reserved_balance" >= 0),
	CONSTRAINT "wallet_accounts_balance_gte_reserved" CHECK ("wallet_accounts"."balance" >= "wallet_accounts"."reserved_balance")
);

CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"idempotency_key" text NOT NULL,
	"reversal_of_transaction_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wallet_transactions_amount_not_zero" CHECK ("wallet_transactions"."amount" <> 0)
);

CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"coins_to_credit" integer NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"merchant_order_id" text NOT NULL,
	"mihpayid" text,
	"payu_txn_id" text,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_merchant_order_id_unique" UNIQUE("merchant_order_id"),
	CONSTRAINT "deposits_mihpayid_unique" UNIQUE("mihpayid")
);

CREATE TABLE "wallet_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"reason_type" "reservation_reason_type" NOT NULL,
	"reason_id" uuid,
	"idempotency_key" text NOT NULL,
	"confirmed_by_transaction_id" uuid,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_reservations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wallet_reservations_amount_positive" CHECK ("wallet_reservations"."amount" > 0)
);

CREATE TABLE "user_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "payout_method" NOT NULL,
	"account_holder_name" text NOT NULL,
	"bank_account_number" text,
	"bank_ifsc_code" text,
	"bank_name" text,
	"upi_id" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_bank_accounts_bank_transfer_fields" CHECK ("user_bank_accounts"."method" != 'bank_transfer' OR (
        "user_bank_accounts"."bank_account_number" IS NOT NULL
        AND length(trim("user_bank_accounts"."bank_account_number")) > 0
        AND "user_bank_accounts"."bank_ifsc_code" IS NOT NULL
        AND "user_bank_accounts"."bank_ifsc_code" ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
      )),
	CONSTRAINT "user_bank_accounts_upi_fields" CHECK ("user_bank_accounts"."method" != 'upi' OR (
        "user_bank_accounts"."upi_id" IS NOT NULL
        AND length(trim("user_bank_accounts"."upi_id")) > 0
      )),
	CONSTRAINT "user_bank_accounts_holder_name_not_empty" CHECK (length(trim("user_bank_accounts"."account_holder_name")) > 0)
);

CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"snapshot_payout_method" "payout_method" NOT NULL,
	"snapshot_account_holder_name" text NOT NULL,
	"snapshot_bank_account_number" text,
	"snapshot_bank_ifsc_code" text,
	"snapshot_bank_name" text,
	"snapshot_upi_id" text,
	"amount" bigint NOT NULL,
	"status" "withdrawal_status" DEFAULT 'reserved' NOT NULL,
	"provider" text,
	"provider_reference" text,
	"provider_submitted_at" timestamp with time zone,
	"webhook_transfer_id" text,
	"submission_attempts" integer DEFAULT 0 NOT NULL,
	"last_submission_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "withdrawals_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "withdrawals_amount_positive" CHECK ("withdrawals"."amount" > 0)
);

CREATE TABLE "competition_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode_id" uuid NOT NULL,
	"type" "competition_type" NOT NULL,
	"status" "competition_schedule_status" DEFAULT 'draft' NOT NULL,
	"entry_fee" integer NOT NULL,
	"max_participants" integer NOT NULL,
	"team_size" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"entry_closes_at" timestamp with time zone,
	"duration_minutes" integer,
	"room_reveal_minutes_before_start" integer,
	"result_deadline_minutes" integer DEFAULT 90 NOT NULL,
	"manager_alert_after_minutes" integer DEFAULT 5 NOT NULL,
	"tournament_metric" text,
	"prizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guide_video_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_schedules_entry_fee_positive" CHECK ("competition_schedules"."entry_fee" > 0),
	CONSTRAINT "competition_schedules_max_participants_positive" CHECK ("competition_schedules"."max_participants" > 0),
	CONSTRAINT "competition_schedules_team_size_positive" CHECK ("competition_schedules"."team_size" > 0),
	CONSTRAINT "competition_schedules_result_deadline_positive" CHECK ("competition_schedules"."result_deadline_minutes" > 0),
	CONSTRAINT "competition_schedules_manager_alert_nonnegative" CHECK ("competition_schedules"."manager_alert_after_minutes" >= 0)
);

CREATE TABLE "competition_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "competition_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mobile_number" text NOT NULL,
	"upi_id" text NOT NULL,
	"role" "host_assignment_type" NOT NULL,
	"status" "host_status" DEFAULT 'active' NOT NULL,
	"current_assignment_type" "host_assignment_type",
	"current_assignment_id" uuid,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_hosts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "competition_hosts_assignment_pair_check" CHECK (("competition_hosts"."current_assignment_type" IS NULL AND "competition_hosts"."current_assignment_id" IS NULL) OR ("competition_hosts"."current_assignment_type" IS NOT NULL AND "competition_hosts"."current_assignment_id" IS NOT NULL))
);

CREATE TABLE "competition_match_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"game_uid" text NOT NULL,
	"game_name" text NOT NULL,
	"seat_number" integer NOT NULL,
	"room_confirmed_at" timestamp with time zone,
	"position" integer,
	"is_cheater" boolean DEFAULT false NOT NULL,
	"prize_amount" integer DEFAULT 0 NOT NULL,
	"reservation_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_match_participants_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "competition_match_participants_match_user_unique" UNIQUE("match_id","user_id"),
	CONSTRAINT "competition_match_participants_match_seat_unique" UNIQUE("match_id","seat_number")
);

CREATE TABLE "competition_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"host_id" uuid,
	"status" "competition_status" DEFAULT 'waiting' NOT NULL,
	"room_id" text,
	"room_password" text,
	"room_details_added_at" timestamp with time zone,
	"host_claimed_at" timestamp with time zone,
	"result_submitted_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancelled_at" timestamp with time zone,
	"screenshot_object_key" text,
	"screenshot_content_type" text,
	"voice_note_object_key" text,
	"manager_unclaimed_alerted_at" timestamp with time zone,
	"manager_unclaimed_snoozed_until" timestamp with time zone,
	"manager_room_timeout_alerted_at" timestamp with time zone,
	"manager_result_timeout_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_matches_code_unique" UNIQUE("code")
);

CREATE TABLE "competition_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_modes_game_name_unique" UNIQUE("game_id","name")
);

CREATE TABLE "competition_tournament_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"game_uid" text NOT NULL,
	"game_name" text NOT NULL,
	"initial_value" integer,
	"final_value" integer,
	"performance" integer,
	"rank" integer,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_cheater" boolean DEFAULT false NOT NULL,
	"prize_amount" integer DEFAULT 0 NOT NULL,
	"reservation_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_tournament_participants_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "competition_tournament_participants_tournament_user_unique" UNIQUE("tournament_id","user_id"),
	CONSTRAINT "competition_tournament_participants_tournament_seat_unique" UNIQUE("tournament_id","game_uid")
);

CREATE TABLE "tournament_position_reveals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"reveal_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tournament_position_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reveal_id" uuid NOT NULL,
	"tournament_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"metric_value" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_position_values_reveal_participant_unique" UNIQUE("reveal_id","participant_id")
);

CREATE TABLE "competition_tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"host_id" uuid,
	"status" "competition_status" DEFAULT 'waiting' NOT NULL,
	"entry_closes_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"host_claimed_at" timestamp with time zone,
	"result_submitted_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancelled_at" timestamp with time zone,
	"voice_note_object_key" text,
	"manager_unclaimed_alerted_at" timestamp with time zone,
	"manager_unclaimed_snoozed_until" timestamp with time zone,
	"manager_result_timeout_alerted_at" timestamp with time zone,
	"participant_list_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_tournaments_code_unique" UNIQUE("code")
);

CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_user_token_unique" UNIQUE("user_id","token")
);

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_account_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversal_of_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("reversal_of_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_wallet_account_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_confirmed_by_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("confirmed_by_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "user_bank_accounts" ADD CONSTRAINT "user_bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_account_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_reservation_id_wallet_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_reservations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_bank_account_id_user_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."user_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_schedules" ADD CONSTRAINT "competition_schedules_mode_id_competition_modes_id_fk" FOREIGN KEY ("mode_id") REFERENCES "public"."competition_modes"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_hosts" ADD CONSTRAINT "competition_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_match_participants" ADD CONSTRAINT "competition_match_participants_match_id_competition_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."competition_matches"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "competition_match_participants" ADD CONSTRAINT "competition_match_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_match_participants" ADD CONSTRAINT "competition_match_participants_reservation_id_wallet_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_reservations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_schedule_id_competition_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."competition_schedules"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_matches" ADD CONSTRAINT "competition_matches_host_id_competition_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."competition_hosts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "competition_modes" ADD CONSTRAINT "competition_modes_game_id_competition_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."competition_games"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_tournament_participants" ADD CONSTRAINT "competition_tournament_participants_tournament_id_competition_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."competition_tournaments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "competition_tournament_participants" ADD CONSTRAINT "competition_tournament_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_tournament_participants" ADD CONSTRAINT "competition_tournament_participants_reservation_id_wallet_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_reservations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "tournament_position_reveals" ADD CONSTRAINT "tournament_position_reveals_schedule_id_competition_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."competition_schedules"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tournament_position_values" ADD CONSTRAINT "tournament_position_values_reveal_id_tournament_position_reveals_id_fk" FOREIGN KEY ("reveal_id") REFERENCES "public"."tournament_position_reveals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tournament_position_values" ADD CONSTRAINT "tournament_position_values_tournament_id_competition_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."competition_tournaments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tournament_position_values" ADD CONSTRAINT "tournament_position_values_participant_id_competition_tournament_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."competition_tournament_participants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "competition_tournaments" ADD CONSTRAINT "competition_tournaments_schedule_id_competition_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."competition_schedules"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "competition_tournaments" ADD CONSTRAINT "competition_tournaments_host_id_competition_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."competition_hosts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "wallet_transactions_account_created_idx" ON "wallet_transactions" USING btree ("wallet_account_id","created_at");
CREATE INDEX "wallet_reservations_account_status_idx" ON "wallet_reservations" USING btree ("wallet_account_id","status");
CREATE INDEX "user_bank_accounts_user_id_idx" ON "user_bank_accounts" USING btree ("user_id");
CREATE INDEX "withdrawals_user_id_created_at_idx" ON "withdrawals" USING btree ("user_id","created_at");
CREATE INDEX "withdrawals_status_created_at_idx" ON "withdrawals" USING btree ("status","created_at");
CREATE INDEX "withdrawals_provider_reference_idx" ON "withdrawals" USING btree ("provider","provider_reference");
CREATE UNIQUE INDEX "withdrawals_one_active_per_user_idx" ON "withdrawals" USING btree ("user_id") WHERE status IN ('reserved', 'processing');
CREATE INDEX "withdrawals_reserved_submission_idx" ON "withdrawals" USING btree ("last_submission_attempt_at","created_at") WHERE status = 'reserved';
CREATE INDEX "competition_schedules_mode_type_status_idx" ON "competition_schedules" USING btree ("mode_id","type","status");
CREATE UNIQUE INDEX "competition_games_name_idx" ON "competition_games" USING btree ("name");
CREATE INDEX "competition_hosts_role_status_assignment_idx" ON "competition_hosts" USING btree ("role","status","current_assignment_id");
CREATE INDEX "competition_match_participants_user_joined_idx" ON "competition_match_participants" USING btree ("user_id","joined_at");
CREATE INDEX "competition_matches_schedule_status_created_idx" ON "competition_matches" USING btree ("schedule_id","status","created_at");
CREATE INDEX "competition_matches_host_status_idx" ON "competition_matches" USING btree ("host_id","status");
CREATE INDEX "competition_modes_game_id_idx" ON "competition_modes" USING btree ("game_id");
CREATE INDEX "competition_tournament_participants_user_joined_idx" ON "competition_tournament_participants" USING btree ("user_id","joined_at");
CREATE INDEX "tournament_position_reveals_schedule_idx" ON "tournament_position_reveals" USING btree ("schedule_id","reveal_at");
CREATE INDEX "tournament_position_values_tournament_reveal_idx" ON "tournament_position_values" USING btree ("tournament_id","reveal_id");
CREATE INDEX "competition_tournaments_schedule_status_created_idx" ON "competition_tournaments" USING btree ("schedule_id","status","created_at");
CREATE INDEX "competition_tournaments_host_status_idx" ON "competition_tournaments" USING btree ("host_id","status");
CREATE INDEX "push_devices_user_active_idx" ON "push_devices" USING btree ("user_id","is_active");
