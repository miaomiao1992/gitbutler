use but_graph::Graph;
use but_testsupport::visualize_commit_graph_all;

use crate::init::utils::{
    add_workspace, add_workspace_without_target, read_only_in_memory_scenario, standard_options,
    standard_options_with_extra_target,
};

#[test]
fn returns_newest_base_when_stacks_have_different_bases() -> anyhow::Result<()> {
    let (repo, mut meta) = read_only_in_memory_scenario("ws/two-branches-one-below-base")?;
    insta::assert_snapshot!(visualize_commit_graph_all(&repo)?, @r"
    *   e82dfab (HEAD -> gitbutler/workspace) GitButler Workspace Commit
    |\  
    | * 6fdab32 (A) A1
    * | 78b1b59 (B) B1
    | | * 938e6f2 (origin/main, main) M4
    | |/  
    |/|   
    * | f52fcec M3
    |/  
    * bce0c5e M2
    * 3183e43 M1
    ");

    // A branches from M2, B branches from M3.
    // newest_base_among_stacks should return M3 (the higher merge base).
    add_workspace(&mut meta);

    let ws = Graph::from_head(&repo, &*meta, standard_options())?
        .validated()?
        .into_workspace()?;

    let newest = ws.newest_base_among_stacks();
    let expected_m3 = repo.rev_parse_single(":/M3")?.detach();
    assert_eq!(
        newest,
        Some(expected_m3),
        "should pick M3 as the newest base, not M2"
    );

    Ok(())
}

#[test]
fn returns_newest_base_when_one_stack_is_above_target() -> anyhow::Result<()> {
    let (repo, mut meta) = read_only_in_memory_scenario("ws/two-branches-one-above-base")?;
    insta::assert_snapshot!(visualize_commit_graph_all(&repo)?, @r"
    *   c5587c9 (HEAD -> gitbutler/workspace) GitButler Workspace Commit
    |\  
    | * de6d39c (A) A1
    | * a821094 (origin/main, main) M3
    * | ce25240 (B) B1
    |/  
    * bce0c5e M2
    * 3183e43 M1
    ");

    // A branches from M3, B branches from M2.
    // newest_base_among_stacks should return M3 (the higher merge base).
    add_workspace(&mut meta);

    let ws = Graph::from_head(&repo, &*meta, standard_options())?
        .validated()?
        .into_workspace()?;

    let newest = ws.newest_base_among_stacks();
    let expected_m3 = repo.rev_parse_single(":/M3")?.detach();
    assert_eq!(
        newest,
        Some(expected_m3),
        "should pick M3 as the newest base, not M2"
    );

    Ok(())
}

#[test]
fn returns_none_when_no_target() -> anyhow::Result<()> {
    let (repo, mut meta) = read_only_in_memory_scenario("ws/no-target-without-ws-commit")?;

    add_workspace_without_target(&mut meta);
    let ws = Graph::from_head(&repo, &*meta, standard_options())?
        .validated()?
        .into_workspace()?;

    assert!(
        ws.newest_base_among_stacks().is_none(),
        "should return None when no target is set"
    );

    Ok(())
}

#[test]
fn with_extra_target() -> anyhow::Result<()> {
    let (repo, mut meta) = read_only_in_memory_scenario("ws/two-branches-one-below-base")?;

    add_workspace(&mut meta);
    meta.data_mut().default_target = None;

    let ws = Graph::from_head(
        &repo,
        &*meta,
        standard_options_with_extra_target(&repo, "main"),
    )?
    .validated()?
    .into_workspace()?;

    let newest = ws.newest_base_among_stacks();
    let expected_m3 = repo.rev_parse_single(":/M3")?.detach();
    assert_eq!(
        newest,
        Some(expected_m3),
        "should work with extra_target when no target_ref is set"
    );

    Ok(())
}
