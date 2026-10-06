#define _DARWIN_C_SOURCE 1
#define __APPLE_API_UNSTABLE 1

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>

#define RENAME_EXCL_VALUE 0x00000004U
#define RENAME_EXCL_CAP_VALUE 0x00080000U
#define P1B_UNSUPPORTED_FLAG_VALUE 0x40000000U

/* Test-only hooks mutate only fresh synthetic fixtures. Race hooks run after
 * identity/vacancy checks and directly before the real renameatx_np call. */
enum test_hook {
    HOOK_NONE,
    HOOK_COLLISION_EMPTY,
    HOOK_COLLISION_NONEMPTY,
    HOOK_COLLISION_FILE,
    HOOK_COLLISION_SYMLINK,
    HOOK_COLLISION_SAMEBYTES,
    HOOK_PARENT_PATH_SWAP,
    HOOK_PARENT_MOVE_OUTSIDE,
    HOOK_SOURCE_BASENAME_SWAP,
    HOOK_UNSUPPORTED_FLAG,
    HOOK_UNKNOWN_ERRNO,
    HOOK_KILL_BEFORE,
    HOOK_KILL_AFTER,
    HOOK_INVALID
};

#if RENAME_EXCL != RENAME_EXCL_VALUE
#error "SDK RENAME_EXCL value differs from the reviewed API value"
#endif
#if VOL_CAP_INT_RENAME_EXCL != RENAME_EXCL_CAP_VALUE
#error "SDK VOL_CAP_INT_RENAME_EXCL value differs from the reviewed API value"
#endif

struct identity {
    uint64_t dev;
    uint64_t ino;
};

struct volume_caps {
    uint32_t valid;
    uint32_t capabilities;
};

static int fail(const char *message, int code)
{
    fprintf(stderr, "error=%s errno=%d\n", message, code);
    return 64;
}

static bool parse_u64(const char *text, uint64_t *value)
{
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') return false;
    *value = (uint64_t)parsed;
    return true;
}

static bool parse_identity(const char *dev_text, const char *ino_text, struct identity *identity)
{
    return parse_u64(dev_text, &identity->dev) && parse_u64(ino_text, &identity->ino);
}

static bool matches_identity(const struct stat *st, const struct identity *identity)
{
    return (uint64_t)st->st_dev == identity->dev && (uint64_t)st->st_ino == identity->ino;
}

static int canonical_root(const char *input, char resolved[PATH_MAX], int *root_fd, struct stat *root_stat)
{
    if (input[0] != '/') return fail("root-not-absolute", EINVAL);
    if (realpath(input, resolved) == NULL) return fail("root-realpath", errno);
    if (strcmp(input, resolved) != 0) return fail("root-not-canonical", ELOOP);

    int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0) return fail("root-open-slash", errno);
    char *copy = strdup(resolved + 1);
    if (copy == NULL) { close(current); return fail("root-path-allocation", ENOMEM); }

    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0 || part[0] == '\0') {
            close(current); free(copy);
            return fail("unsafe-root-component", EINVAL);
        }
        int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current); free(copy);
            return fail("root-component-openat", saved);
        }
        close(current);
        current = next;
    }
    free(copy);
    *root_fd = current;
    if (fstat(*root_fd, root_stat) != 0) return fail("root-fstat", errno);
    if (!S_ISDIR(root_stat->st_mode)) return fail("root-not-directory", ENOTDIR);
    return 0;
}

static int query_volume_caps(const char *root_path, struct volume_caps *caps)
{
    struct attrlist attributes;
    memset(&attributes, 0, sizeof(attributes));
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.volattr = ATTR_VOL_CAPABILITIES;

    struct {
        uint32_t length;
        vol_capabilities_attr_t attributes;
    } buffer;
    memset(&buffer, 0, sizeof(buffer));

    if (getattrlist(root_path, &attributes, &buffer, sizeof(buffer), FSOPT_NOFOLLOW) != 0)
        return -1;
    if (buffer.length < sizeof(buffer)) {
        errno = EIO;
        return -1;
    }
    caps->valid = buffer.attributes.valid[VOL_CAPABILITIES_INTERFACES];
    caps->capabilities = buffer.attributes.capabilities[VOL_CAPABILITIES_INTERFACES];
    return 0;
}

static int open_relative_directory(int root_fd, const char *relative, int *result_fd)
{
    if (strcmp(relative, ".") == 0) {
        *result_fd = dup(root_fd);
        if (*result_fd < 0) return fail("dup-root", errno);
        return 0;
    }
    if (relative[0] == '\0' || relative[0] == '/' || relative[strlen(relative) - 1] == '/')
        return fail("parent-path-not-relative", EINVAL);

    char *copy = strdup(relative);
    if (copy == NULL) return fail("parent-path-allocation", ENOMEM);

    int current = dup(root_fd);
    if (current < 0) {
        free(copy);
        return fail("dup-root", errno);
    }

    char *save = NULL;
    for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0 || part[0] == '\0') {
            close(current);
            free(copy);
            return fail("unsafe-parent-component", EINVAL);
        }
        int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            int saved = errno;
            close(current);
            free(copy);
            return fail("parent-openat", saved);
        }
        close(current);
        current = next;
    }
    free(copy);
    *result_fd = current;
    return 0;
}

static bool valid_basename(const char *name)
{
    return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static const char *errno_name(int code)
{
    switch (code) {
        case EEXIST: return "EEXIST";
        case ENOENT: return "ENOENT";
        case EINVAL: return "EINVAL";
        case ENOTSUP: return "ENOTSUP";
        case EXDEV: return "EXDEV";
        case ELOOP: return "ELOOP";
        default: return "OTHER";
    }
}

static enum test_hook parse_test_hook(const char *option)
{
    if (option == NULL) return HOOK_NONE;
    if (strcmp(option, "--race-empty-dir") == 0 || strcmp(option, "--race-collision=empty-dir") == 0) return HOOK_COLLISION_EMPTY;
    if (strcmp(option, "--race-collision=nonempty-dir") == 0) return HOOK_COLLISION_NONEMPTY;
    if (strcmp(option, "--race-collision=file") == 0) return HOOK_COLLISION_FILE;
    if (strcmp(option, "--race-collision=symlink") == 0) return HOOK_COLLISION_SYMLINK;
    if (strcmp(option, "--race-collision=samebytes-dir") == 0) return HOOK_COLLISION_SAMEBYTES;
    if (strcmp(option, "--race-parent-path-swap") == 0) return HOOK_PARENT_PATH_SWAP;
    if (strcmp(option, "--race-parent-move-outside") == 0) return HOOK_PARENT_MOVE_OUTSIDE;
    if (strcmp(option, "--race-source-basename-swap") == 0) return HOOK_SOURCE_BASENAME_SWAP;
    if (strcmp(option, "--race-unsupported-flag") == 0) return HOOK_UNSUPPORTED_FLAG;
    if (strcmp(option, "--test-unknown-errno") == 0) return HOOK_UNKNOWN_ERRNO;
    if (strcmp(option, "--test-kill-before-syscall") == 0) return HOOK_KILL_BEFORE;
    if (strcmp(option, "--test-kill-after-syscall") == 0) return HOOK_KILL_AFTER;
    return HOOK_INVALID;
}

static int write_all(int fd, const void *bytes, size_t length)
{
    const unsigned char *cursor = bytes;
    size_t written = 0;
    while (written < length) {
        ssize_t result = write(fd, cursor + written, length - written);
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (result == 0) { errno = EIO; return -1; }
        written += (size_t)result;
    }
    return 0;
}

static int write_file_at(int parent_fd, const char *name, const void *bytes, size_t length)
{
    int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    int result = write_all(fd, bytes, length);
    int saved = errno;
    if (close(fd) != 0 && result == 0) { result = -1; saved = errno; }
    errno = saved;
    return result;
}

static int copy_source_payload(int source_parent_fd, const char *source_name, int destination_dir_fd)
{
    int source_dir_fd = openat(source_parent_fd, source_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (source_dir_fd < 0) return -1;
    int input_fd = openat(source_dir_fd, "payload.txt", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (input_fd < 0) { int saved = errno; close(source_dir_fd); errno = saved; return -1; }
    int output_fd = openat(destination_dir_fd, "payload.txt", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (output_fd < 0) { int saved = errno; close(input_fd); close(source_dir_fd); errno = saved; return -1; }

    unsigned char buffer[4096];
    int result = 0;
    for (;;) {
        ssize_t count = read(input_fd, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            result = -1;
            break;
        }
        if (write_all(output_fd, buffer, (size_t)count) != 0) { result = -1; break; }
    }
    int saved = errno;
    if (close(output_fd) != 0 && result == 0) { result = -1; saved = errno; }
    if (close(input_fd) != 0 && result == 0) { result = -1; saved = errno; }
    close(source_dir_fd);
    errno = saved;
    return result;
}

static int create_collision(int target_parent_fd, const char *target_name,
                            int source_parent_fd, const char *source_name,
                            enum test_hook hook, struct stat *external_stat)
{
    static const char file_sentinel[] = "external file sentinel\n";
    static const char directory_sentinel[] = "external directory sentinel\n";
    if (hook == HOOK_COLLISION_EMPTY) {
        if (mkdirat(target_parent_fd, target_name, 0751) != 0) return -1;
    } else if (hook == HOOK_COLLISION_NONEMPTY) {
        if (mkdirat(target_parent_fd, target_name, 0751) != 0) return -1;
        int directory_fd = openat(target_parent_fd, target_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (directory_fd < 0) return -1;
        int result = write_file_at(directory_fd, "sentinel.txt", directory_sentinel, sizeof(directory_sentinel) - 1);
        int saved = errno;
        close(directory_fd);
        if (result != 0) { errno = saved; return -1; }
    } else if (hook == HOOK_COLLISION_FILE) {
        if (write_file_at(target_parent_fd, target_name, file_sentinel, sizeof(file_sentinel) - 1) != 0) return -1;
    } else if (hook == HOOK_COLLISION_SYMLINK) {
        if (symlinkat("external-symlink-target", target_parent_fd, target_name) != 0) return -1;
    } else if (hook == HOOK_COLLISION_SAMEBYTES) {
        if (mkdirat(target_parent_fd, target_name, 0751) != 0) return -1;
        int directory_fd = openat(target_parent_fd, target_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (directory_fd < 0) return -1;
        int result = copy_source_payload(source_parent_fd, source_name, directory_fd);
        int saved = errno;
        close(directory_fd);
        if (result != 0) { errno = saved; return -1; }
    } else {
        errno = EINVAL;
        return -1;
    }
    return fstatat(target_parent_fd, target_name, external_stat, AT_SYMLINK_NOFOLLOW);
}

static int make_replacement_parent(int root_fd, const char *parent_name, const char *target_name)
{
    static const char sentinel[] = "replacement parent sentinel\n";
    if (mkdirat(root_fd, parent_name, 0700) != 0) return -1;
    int replacement_fd = openat(root_fd, parent_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (replacement_fd < 0) return -1;
    int result = write_file_at(replacement_fd, target_name, sentinel, sizeof(sentinel) - 1);
    int saved = errno;
    close(replacement_fd);
    if (result != 0) errno = saved;
    return result;
}

static int inject_parent_path_swap(int root_fd, const char *parent_relative, const char *target_name)
{
    if (strchr(parent_relative, '/') != NULL || strcmp(parent_relative, ".") == 0) { errno = EINVAL; return -1; }
    if (renameatx_np(root_fd, parent_relative, root_fd, ".p1b-parent-path-swap", RENAME_EXCL) != 0) return -1;
    return make_replacement_parent(root_fd, parent_relative, target_name);
}

static int inject_parent_move_outside(int root_fd, const char *root_path,
                                      const char *parent_relative, const char *target_name,
                                      char outside_name[NAME_MAX + 1])
{
    if (strchr(parent_relative, '/') != NULL || strcmp(parent_relative, ".") == 0) { errno = EINVAL; return -1; }
    const char *root_basename = strrchr(root_path, '/');
    root_basename = root_basename == NULL ? root_path : root_basename + 1;
    int length = snprintf(outside_name, NAME_MAX + 1, "%s.p1b-outside-parent", root_basename);
    if (length < 0 || length > NAME_MAX) { errno = ENAMETOOLONG; return -1; }
    int root_parent_fd = openat(root_fd, "..", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (root_parent_fd < 0) return -1;
    if (renameatx_np(root_fd, parent_relative, root_parent_fd, outside_name, RENAME_EXCL) != 0) {
        int saved = errno;
        close(root_parent_fd);
        errno = saved;
        return -1;
    }
    int result = make_replacement_parent(root_fd, parent_relative, target_name);
    int saved = errno;
    close(root_parent_fd);
    errno = saved;
    return result;
}

static int inject_source_basename_swap(int source_parent_fd, const char *source_name)
{
    if (mkdirat(source_parent_fd, ".p1b-source-replacement", 0700) != 0) return -1;
    int replacement_fd = openat(source_parent_fd, ".p1b-source-replacement", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (replacement_fd < 0) return -1;
    int result = copy_source_payload(source_parent_fd, source_name, replacement_fd);
    int saved = errno;
    close(replacement_fd);
    if (result != 0) { errno = saved; return -1; }
    if (renameatx_np(source_parent_fd, source_name, source_parent_fd, ".p1b-source-held", RENAME_EXCL) != 0) return -1;
    return renameatx_np(source_parent_fd, ".p1b-source-replacement", source_parent_fd, source_name, RENAME_EXCL);
}

static int capabilities_command(const char *root_input)
{
    char root_path[PATH_MAX];
    int root_fd = -1;
    struct stat root_stat;
    int status = canonical_root(root_input, root_path, &root_fd, &root_stat);
    if (status != 0) return status;

    struct volume_caps caps;
    if (query_volume_caps(root_path, &caps) != 0) {
        int saved = errno;
        close(root_fd);
        return fail("getattrlist-volume-capabilities", saved);
    }
    close(root_fd);

    bool valid = (caps.valid & RENAME_EXCL_CAP_VALUE) != 0;
    bool supported = (caps.capabilities & RENAME_EXCL_CAP_VALUE) != 0;
    printf("{\"operation\":\"volume-capabilities\",\"volume_dev\":\"%" PRIu64 "\",\"valid_interfaces_hex\":\"0x%08" PRIx32 "\",\"capabilities_interfaces_hex\":\"0x%08" PRIx32 "\",\"rename_excl_valid\":%s,\"rename_excl_supported\":%s}\n",
           (uint64_t)root_stat.st_dev, caps.valid, caps.capabilities,
           valid ? "true" : "false", supported ? "true" : "false");
    if (!valid || !supported) return fail("volume-does-not-advertise-valid-rename-excl", ENOTSUP);
    return 0;
}

static int place_command(int argc, char **argv)
{
    if (argc != 15 && argc != 16) return fail("place-argument-count", EINVAL);
    enum test_hook hook = parse_test_hook(argc == 16 ? argv[15] : NULL);
    if (hook == HOOK_INVALID) return fail("unknown-place-option", EINVAL);

    const char *root_input = argv[2];
    const char *source_parent_relative = argv[3];
    const char *source_name = argv[4];
    const char *target_parent_relative = argv[5];
    const char *target_name = argv[6];
    if (!valid_basename(source_name) || !valid_basename(target_name))
        return fail("basename-must-be-single-component", EINVAL);

    struct identity expected_root, expected_source_parent, expected_target_parent, expected_source;
    if (!parse_identity(argv[7], argv[8], &expected_root) ||
        !parse_identity(argv[9], argv[10], &expected_source_parent) ||
        !parse_identity(argv[11], argv[12], &expected_target_parent) ||
        !parse_identity(argv[13], argv[14], &expected_source))
        return fail("identity-parse", EINVAL);

    char root_path[PATH_MAX];
    int root_fd = -1;
    struct stat root_stat;
    int status = canonical_root(root_input, root_path, &root_fd, &root_stat);
    if (status != 0) return status;
    if (!matches_identity(&root_stat, &expected_root)) {
        close(root_fd);
        return fail("root-identity-mismatch", ESTALE);
    }

    struct volume_caps caps;
    if (query_volume_caps(root_path, &caps) != 0) {
        int saved = errno;
        close(root_fd);
        return fail("getattrlist-volume-capabilities", saved);
    }
    if ((caps.valid & RENAME_EXCL_CAP_VALUE) == 0 ||
        (caps.capabilities & RENAME_EXCL_CAP_VALUE) == 0) {
        close(root_fd);
        return fail("volume-does-not-advertise-valid-rename-excl", ENOTSUP);
    }

    int source_parent_fd = -1;
    int target_parent_fd = -1;
    status = open_relative_directory(root_fd, source_parent_relative, &source_parent_fd);
    if (status != 0) { close(root_fd); return status; }
    status = open_relative_directory(root_fd, target_parent_relative, &target_parent_fd);
    if (status != 0) { close(source_parent_fd); close(root_fd); return status; }

    struct stat source_parent_stat, target_parent_stat;
    if (fstat(source_parent_fd, &source_parent_stat) != 0 ||
        fstat(target_parent_fd, &target_parent_stat) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-fstat", saved);
    }
    if (!matches_identity(&source_parent_stat, &expected_source_parent) ||
        !matches_identity(&target_parent_stat, &expected_target_parent)) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-identity-mismatch", ESTALE);
    }
    if (source_parent_stat.st_dev != root_stat.st_dev || target_parent_stat.st_dev != root_stat.st_dev) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("parent-volume-mismatch", EXDEV);
    }

    struct stat source_stat;
    if (fstatat(source_parent_fd, source_name, &source_stat, AT_SYMLINK_NOFOLLOW) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-fstatat", saved);
    }
    if (!S_ISDIR(source_stat.st_mode) || !matches_identity(&source_stat, &expected_source)) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-type-or-identity-mismatch", ESTALE);
    }
    if (source_stat.st_dev != target_parent_stat.st_dev) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("source-volume-mismatch", EXDEV);
    }

    struct stat target_stat;
    if (fstatat(target_parent_fd, target_name, &target_stat, AT_SYMLINK_NOFOLLOW) == 0) {
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("target-not-vacant", EEXIST);
    }
    if (errno != ENOENT) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("target-vacancy-fstatat", saved);
    }

    struct stat external_stat;
    memset(&external_stat, 0, sizeof(external_stat));
    char outside_parent_name[NAME_MAX + 1] = {0};
    int hook_result = 0;
    switch (hook) {
        case HOOK_COLLISION_EMPTY:
        case HOOK_COLLISION_NONEMPTY:
        case HOOK_COLLISION_FILE:
        case HOOK_COLLISION_SYMLINK:
        case HOOK_COLLISION_SAMEBYTES:
            hook_result = create_collision(target_parent_fd, target_name, source_parent_fd,
                                           source_name, hook, &external_stat);
            break;
        case HOOK_PARENT_PATH_SWAP:
            hook_result = inject_parent_path_swap(root_fd, target_parent_relative, target_name);
            break;
        case HOOK_PARENT_MOVE_OUTSIDE:
            hook_result = inject_parent_move_outside(root_fd, root_path, target_parent_relative,
                                                     target_name, outside_parent_name);
            break;
        case HOOK_SOURCE_BASENAME_SWAP:
            hook_result = inject_source_basename_swap(source_parent_fd, source_name);
            break;
        default:
            break;
    }
    if (hook_result != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("test-interposition", saved);
    }

    if (hook == HOOK_UNKNOWN_ERRNO) {
        int injected_errno = EACCES;
        printf("{\"operation\":\"test-only-error-injection\",\"result\":\"refused\",\"errno\":%d,\"errno_name\":\"%s\",\"filesystem_result\":false,\"syscall_performed\":false,\"test_interposition\":\"before-renameatx_np-without-syscall\"}\n",
               injected_errno, errno_name(injected_errno));
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("test-injected-unknown-errno", injected_errno);
    }
    if (hook == HOOK_KILL_BEFORE && kill(getpid(), SIGKILL) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("test-kill-before-syscall", saved);
    }

    unsigned int rename_flags = RENAME_EXCL;
    const char *flag_name = "RENAME_EXCL";
    if (hook == HOOK_UNSUPPORTED_FLAG) {
        rename_flags |= P1B_UNSUPPORTED_FLAG_VALUE;
        flag_name = "RENAME_EXCL|UNSUPPORTED_TEST_BIT";
    }
    errno = 0;
    int rename_result = renameatx_np(source_parent_fd, source_name, target_parent_fd, target_name, rename_flags);
    int rename_errno = rename_result == 0 ? 0 : errno;
    if (hook == HOOK_KILL_AFTER && rename_result == 0 && kill(getpid(), SIGKILL) != 0) {
        int saved = errno;
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        return fail("test-kill-after-syscall", saved);
    }

    if (rename_result == 0) {
        struct stat placed_stat;
        bool identity_preserved = fstatat(target_parent_fd, target_name, &placed_stat, AT_SYMLINK_NOFOLLOW) == 0 &&
                                  matches_identity(&placed_stat, &expected_source);
        if (hook == HOOK_PARENT_PATH_SWAP) {
            printf("{\"operation\":\"renameatx_np\",\"flag\":\"RENAME_EXCL\",\"result\":\"placed\",\"errno\":0,\"source_dev\":\"%" PRIu64 "\",\"source_ino\":\"%" PRIu64 "\",\"destination_identity_preserved\":%s,\"boundary\":\"LIMIT\",\"test_interposition\":\"immediately-before-real-renameatx_np\",\"parent_path_replaced\":true}\n",
                   expected_source.dev, expected_source.ino, identity_preserved ? "true" : "false");
        } else if (hook == HOOK_PARENT_MOVE_OUTSIDE) {
            printf("{\"operation\":\"renameatx_np\",\"flag\":\"RENAME_EXCL\",\"result\":\"placed\",\"errno\":0,\"source_dev\":\"%" PRIu64 "\",\"source_ino\":\"%" PRIu64 "\",\"destination_identity_preserved\":%s,\"boundary\":\"LIMIT\",\"test_interposition\":\"immediately-before-real-renameatx_np\",\"moved_parent_outside_root\":true,\"outside_parent_name\":\"%s\"}\n",
                   expected_source.dev, expected_source.ino, identity_preserved ? "true" : "false", outside_parent_name);
        } else if (hook == HOOK_SOURCE_BASENAME_SWAP) {
            printf("{\"operation\":\"renameatx_np\",\"flag\":\"RENAME_EXCL\",\"result\":\"placed\",\"errno\":0,\"source_dev\":\"%" PRIu64 "\",\"source_ino\":\"%" PRIu64 "\",\"destination_identity_preserved\":%s,\"boundary\":\"LIMIT\",\"test_interposition\":\"immediately-before-real-renameatx_np\"}\n",
                   expected_source.dev, expected_source.ino, identity_preserved ? "true" : "false");
        } else {
            printf("{\"operation\":\"renameatx_np\",\"flag\":\"%s\",\"result\":\"placed\",\"errno\":0,\"source_dev\":\"%" PRIu64 "\",\"source_ino\":\"%" PRIu64 "\",\"destination_identity_preserved\":%s}\n",
                   flag_name, expected_source.dev, expected_source.ino, identity_preserved ? "true" : "false");
        }
        close(target_parent_fd); close(source_parent_fd); close(root_fd);
        if (!identity_preserved) return fail("post-placement-source-identity-mismatch", ESTALE);
        return 0;
    }

    const char *test_interposition = hook >= HOOK_COLLISION_EMPTY && hook <= HOOK_COLLISION_SAMEBYTES
        ? ",\"test_interposition\":\"immediately-before-real-renameatx_np\"" : "";
    printf("{\"operation\":\"renameatx_np\",\"flag\":\"%s\",\"result\":\"refused\",\"errno\":%d,\"errno_name\":\"%s\",\"injected_external_dev\":\"%" PRIu64 "\",\"injected_external_ino\":\"%" PRIu64 "\",\"injected_external_mode\":%u%s}\n",
           flag_name, rename_errno, errno_name(rename_errno), (uint64_t)external_stat.st_dev,
           (uint64_t)external_stat.st_ino, (unsigned)(external_stat.st_mode & 0777), test_interposition);
    close(target_parent_fd); close(source_parent_fd); close(root_fd);
    if (hook >= HOOK_COLLISION_EMPTY && hook <= HOOK_COLLISION_SAMEBYTES && rename_errno == EEXIST) return 1;
    return fail("renameatx_np", rename_errno);
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "capabilities") == 0)
        return capabilities_command(argv[2]);
    if (argc >= 2 && strcmp(argv[1], "place") == 0)
        return place_command(argc, argv);
    fprintf(stderr, "usage: %s capabilities ABSOLUTE_ROOT | place ROOT SRC_PARENT SRC_NAME DST_PARENT DST_NAME ROOT_DEV ROOT_INO SRC_PARENT_DEV SRC_PARENT_INO DST_PARENT_DEV DST_PARENT_INO SRC_DEV SRC_INO [TEST_ONLY_HOOK]\n", argv[0]);
    return 64;
}
