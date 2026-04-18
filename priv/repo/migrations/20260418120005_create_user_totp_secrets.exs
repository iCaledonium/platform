defmodule Platform.Repo.Migrations.CreateUserTotpSecrets do
  use Ecto.Migration

  def change do
    create table(:user_totp_secrets, primary_key: false) do
      add :id,               :string, primary_key: true, null: false
      add :user_id,          :string, null: false, references: :users, type: :string
      add :encrypted_secret, :string, null: false
      # base32 TOTP secret, encrypted at rest via Application.get_env secret_key_base
      add :enrolled_at,      :naive_datetime_usec, null: false

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:user_totp_secrets, [:user_id])
  end
end
