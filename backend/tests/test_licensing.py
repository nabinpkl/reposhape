"""Which license a repo carries, and whose copyright it states."""

from pathlib import Path

from reposhape import licensing


def test_apaches_how_to_apply_template_is_nobodys_copyright(tmp_path: Path):
    """Apache-2.0 ends with a template notice; only the real one is the holder."""
    (tmp_path / "LICENSE.txt").write_text(
        "                                 Apache License\n"
        "                           Version 2.0, January 2004\n"
        "      and issue tracking systems that are managed by, or on behalf of, the\n"
        "      copyright notice that is included in or attached to the work\n"
        "      (c) You must retain, in the Source form of any Derivative Works\n"
        "      Copyright [yyyy] [name of copyright owner]\n"
    )
    (tmp_path / "NOTICE").write_text("not a license file\n")
    found = licensing.find(tmp_path)
    assert found.path == "LICENSE.txt"
    assert found.name == "Apache-2.0"
    assert found.copyright == []


def test_a_text_this_does_not_recognise_is_shown_unnamed(tmp_path: Path):
    """Null is honest; a guessed SPDX id is not."""
    (tmp_path / "COPYING").write_text("Copyright 2020 Someone\nAll rights reserved.\n")
    found = licensing.find(tmp_path)
    assert found.name is None
    assert found.copyright == ["Copyright 2020 Someone"]
    assert "All rights reserved." in found.text


def test_license_is_preferred_over_copying(tmp_path: Path):
    (tmp_path / "COPYING").write_text("gpl\n")
    (tmp_path / "license.md").write_text(
        "Permission is hereby granted, free of charge, to any person\n"
    )
    assert licensing.find(tmp_path).path == "license.md"
    assert licensing.find(tmp_path).name == "MIT"


def test_bsd_3_is_told_from_bsd_2_by_its_third_clause(tmp_path: Path):
    body = "Redistribution and use in source and binary forms, with or without\n"
    (tmp_path / "LICENSE").write_text(body + "3. Neither the name of the copyright holder\n")
    assert licensing.find(tmp_path).name == "BSD-3-Clause"
    (tmp_path / "LICENSE").write_text(body)
    assert licensing.find(tmp_path).name == "BSD-2-Clause"


def test_a_file_takes_the_nearest_license_above_it(tmp_path: Path):
    """A package's own license, under its own holder, beats the root's."""
    mit = "Permission is hereby granted, free of charge, to any person\n"
    (tmp_path / "LICENSE").write_text("Copyright (c) 2025 Root Org\n" + mit)
    (tmp_path / "packages" / "docs" / "src").mkdir(parents=True)
    (tmp_path / "packages" / "docs" / "LICENSE").write_text("Copyright (c) 2023 Vendor\n" + mit)
    (tmp_path / "packages" / "docs" / "src" / "page.ts").write_text("")
    (tmp_path / "packages" / "other").mkdir()
    (tmp_path / "packages" / "other" / "x.ts").write_text("")

    nested = licensing.find(tmp_path, "packages/docs/src/page.ts")
    assert nested.path == "packages/docs/LICENSE"
    assert nested.copyright == ["Copyright (c) 2023 Vendor"]

    elsewhere = licensing.find(tmp_path, "packages/other/x.ts")
    assert elsewhere.path == "LICENSE"
    assert elsewhere.copyright == ["Copyright (c) 2025 Root Org"]


def test_a_license_beside_the_file_counts(tmp_path: Path):
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin" / "LICENSE").write_text("Apache License\nVersion 2.0\n")
    (tmp_path / "plugin" / "main.py").write_text("")
    assert licensing.find(tmp_path, "plugin/main.py").name == "Apache-2.0"


def test_nothing_above_the_file_is_reported_as_nothing(tmp_path: Path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "b.py").write_text("")
    assert licensing.find(tmp_path, "a/b.py").path is None


def test_every_notice_shape_is_a_holder(tmp_path: Path):
    (tmp_path / "LICENSE").write_text(
        "Copyright (c) LangChain, Inc.\nCopyright 2020 Someone\n© 2021 Other\n(c) 2022 Third\n"
    )
    assert licensing.find(tmp_path).copyright == [
        "Copyright (c) LangChain, Inc.",
        "Copyright 2020 Someone",
        "© 2021 Other",
        "(c) 2022 Third",
    ]


def test_apaches_notice_travels_with_its_license(tmp_path: Path):
    """Section 4(d): the NOTICE beside the LICENSE goes wherever the code does."""
    (tmp_path / "LICENSE").write_text("Copyright (c) 2025 Root\n")
    (tmp_path / "NOTICE").write_text("root notice, not this plugin's\n")
    plugin = tmp_path / "plugins" / "guard"
    plugin.mkdir(parents=True)
    (plugin / "LICENSE").write_text("Apache License\nVersion 2.0\n")
    (plugin / "NOTICE.txt").write_text("Guard\nCopyright 2024 Guard Authors\n")
    (plugin / "main.py").write_text("")

    found = licensing.find(tmp_path, "plugins/guard/main.py")
    assert found.notice_path == "plugins/guard/NOTICE.txt"
    assert "Guard Authors" in found.notice_text
    assert found.copyright == ["Copyright 2024 Guard Authors"]


def test_a_license_without_a_notice_has_none(tmp_path: Path):
    (tmp_path / "LICENSE").write_text("Copyright (c) 2025 Root\n")
    found = licensing.find(tmp_path)
    assert found.notice_path is None
    assert found.notice_text == ""
