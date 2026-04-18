defmodule Platform.Repo.Migrations.CreateEnrollmentInvites do
  use Ecto.Migration

  def change do
    create table(:enrollment_invites, primary_key: false) do
      add :id,         :string, primary_key: true, null: false
      add :user_id,    :string, null: false, references: :users, type: :string
      add :token,      :string, null: false
      # one-time token delivered in email link — SHA256 hex
      add :expires_at, :naive_datetime_usec, null: false
      add :used_at,    :naive_datetime_usec
      # null = not yet consumed

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:enrollment_invites, [:token])
    create index(:enrollment_invites, [:user_id])
    create index(:enrollment_invites, [:expires_at])
  end
end
