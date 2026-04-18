defmodule Platform.Repo.Migrations.CreateLoginChallenges do
  use Ecto.Migration

  def change do
    create table(:login_challenges, primary_key: false) do
      add :id,           :string, primary_key: true, null: false
      add :user_id,      :string, null: false, references: :users, type: :string
      add :ip_address,   :string
      add :succeeded,    :integer, null: false, default: 0
      # SQLite booleans are integers: 0 | 1
      add :attempted_at, :naive_datetime_usec, null: false

      timestamps(type: :naive_datetime_usec)
    end

    create index(:login_challenges, [:user_id])
    create index(:login_challenges, [:attempted_at])
    # used for rate-limit queries: recent failed attempts per user
  end
end
