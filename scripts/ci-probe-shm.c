// TEMPORARY CI diagnostic (to be removed once the macOS shm_open EACCES
// puzzle is solved): distinguishes "the OS denies reopen" from "Zig's std
// misbehaves" by exercising raw libc shm_open directly.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
    const char *n = "/takyon_probe";
    shm_unlink(n);

    errno = 0;
    int fd = shm_open(n, O_RDWR | O_CREAT | O_EXCL, 0666);
    printf("create fd=%d errno=%d (%s)\n", fd, errno, fd < 0 ? strerror(errno) : "ok");
    if (fd >= 0) {
        if (ftruncate(fd, 16777216) != 0) printf("ftruncate errno=%d (%s)\n", errno, strerror(errno));
        close(fd);
    }

    errno = 0;
    int fd2 = shm_open(n, O_RDWR, 0666);
    printf("reopen-rw fd=%d errno=%d (%s)\n", fd2, errno, fd2 < 0 ? strerror(errno) : "ok");
    if (fd2 >= 0) close(fd2);

    errno = 0;
    int fd3 = shm_open(n, O_RDONLY, 0666);
    printf("reopen-ro fd=%d errno=%d (%s)\n", fd3, errno, fd3 < 0 ? strerror(errno) : "ok");
    if (fd3 >= 0) close(fd3);

    shm_unlink(n);
    return 0;
}
