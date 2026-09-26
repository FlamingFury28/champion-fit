import app
from storage import SQLiteStorage


def test_accounts_exposes_only_unambiguous_verified_historical_aliases(tmp_path, monkeypatch):
    storage = SQLiteStorage(tmp_path / "aliases.db", app.SCHEMA_PATH)
    storage.initialize()
    monkeypatch.setattr(app, "STORAGE", storage)
    connection = storage.connect()
    try:
        connection.executemany(
            "INSERT INTO riot_account_identities(identity_id,account) VALUES(?,?)",
            [("identity-a", "New#EUW"), ("identity-b", "Other#EUW")],
        )
        connection.executemany(
            "INSERT INTO riot_identity_puuids(puuid,identity_id) VALUES(?,?)",
            [("puuid-a", "identity-a"), ("puuid-b", "identity-b")],
        )
        connection.executemany("INSERT INTO tracked_account_puuids VALUES(?,?)", [
            ("puuid-a", "New#EUW"), ("puuid-b", "Other#EUW"),
        ])
        aliases = [
            ("New#EUW", "old#euw", "Old#EUW", "puuid-a"),
            ("New#EUW", "shared#euw", "Shared#EUW", "puuid-a"),
            ("Other#EUW", "shared#euw", "Shared#EUW", "puuid-b"),
            ("New#EUW", "other#euw", "Other#EUW", "puuid-a"),
        ]
        connection.executemany(
            "INSERT INTO riot_account_aliases VALUES(?,?,?,?,?,?)",
            [(*row, "riot_account_v1", "2026-09-08") for row in aliases],
        )
        connection.commit()
    finally:
        connection.close()

    status, data = app.query_database("/api/accounts", {})
    assert status == 200
    accounts = {item["account"]: item for item in data["items"]}
    assert accounts["New#EUW"]["aliases"] == ["Old#EUW"]
    assert accounts["Other#EUW"]["aliases"] == []
    assert app.query_database("/api/accounts", {"q": ["old#"]})[1]["items"] == [accounts["New#EUW"]]
